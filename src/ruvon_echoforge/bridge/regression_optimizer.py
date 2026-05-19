"""
Regression Optimizer — learns per-strategy-type decay rates from live outcome data.

How it works
------------
Observations are (features, outcome_score) pairs buffered per strategy_type.
An SGDRegressor is fitted to predict outcome_score from market-state features:
  features = [vpin, regime_numeric]     (vpin ∈ [0,1]; regime: LowVol=0, HighVol=0.5, Crisis=1)

predict(strategy_type, features) returns the model's output clipped to DECAY_CLAMP.
Interpretation: higher predicted outcome → pattern confident in current state → faster
decay (higher α means the echo learns from each result more aggressively). Lower
predicted outcome → be conservative → slow decay → keep aliveness stable.

The optimizer pushes PHIC updates only when R² > R2_GATE and n ≥ MIN_SAMPLES.
A Sharpe safety-net auto-reverts if post-push performance degrades.

Persistence: models are saved to `model_dir` via joblib every UPDATE_INTERVAL_S
and reloaded on startup, so learning survives bridge restarts.
"""

import collections
import logging
import math
import os
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

DECAY_CLAMP      = (0.02, 0.25)
R2_GATE          = 0.30
MIN_SAMPLES      = 50
UPDATE_INTERVAL_S = 300          # retrain every 5 minutes
REVERT_SHARPE_DROP = 0.15       # auto-revert if Sharpe drops >15% relative after push
REVERT_WINDOW    = 50           # outcomes to observe before evaluating post-push Sharpe

_REGIME_NUMERIC = {"LowVol": 0.0, "HighVol": 0.5, "Crisis": 1.0}


# ── Model container ───────────────────────────────────────────────────────────

@dataclass
class _ModelEntry:
    model:       object = None   # SGDRegressor
    scaler:      object = None   # StandardScaler
    r2:          float  = 0.0
    n:           int    = 0
    last_update: int    = 0      # epoch-ms
    se_mean:     float  = 0.0   # SE of mean outcome (σ/√n) — used to contract DECAY_CLAMP


# ── Main class ────────────────────────────────────────────────────────────────

class RegressionOptimizer:
    """
    Per-strategy-type SGD regression for adaptive decay rate learning.

    Parameters
    ----------
    model_dir   Directory for joblib persistence (created if absent).
    """

    def __init__(self, model_dir: str = "models/") -> None:
        self._model_dir = model_dir
        os.makedirs(model_dir, exist_ok=True)

        self._models:  dict[str, _ModelEntry]              = {}
        self._buffers: dict[str, list[tuple[list, float]]] = collections.defaultdict(list)

        # Post-push Sharpe tracking for safety-net revert
        self._sharpe_before: dict[str, float] = {}            # strategy_type → Sharpe at push time
        self._post_push_scores: dict[str, list[float]] = collections.defaultdict(list)

        self._load_models()

    # ── Public API ────────────────────────────────────────────────────────────

    def add_observation(
        self,
        strategy_type: str,
        vpin:          float,
        regime_tag:    str,
        outcome_score: float,
    ) -> None:
        """Buffer one training example. Call for every recorded outcome."""
        features = [
            float(vpin),
            _REGIME_NUMERIC.get(regime_tag, 0.0),
        ]
        buf = self._buffers[strategy_type]
        buf.append((features, outcome_score))
        if len(buf) > 1000:
            buf.pop(0)

        # Track post-push outcomes for safety-net evaluation
        if strategy_type in self._post_push_scores:
            self._post_push_scores[strategy_type].append(outcome_score)

    def retrain(self, strategy_type: str) -> bool:
        """
        Fit (or partial-fit) the model for one strategy type.
        Returns True if the model meets R2_GATE after training.
        """
        try:
            from sklearn.linear_model import SGDRegressor
            from sklearn.preprocessing import StandardScaler
        except ImportError:
            logger.warning("scikit-learn not installed — regression optimizer disabled")
            return False

        buf = self._buffers.get(strategy_type, [])
        if len(buf) < MIN_SAMPLES:
            return False

        X = [b[0] for b in buf]
        y = [b[1] for b in buf]

        entry = self._models.setdefault(strategy_type, _ModelEntry(
            model=SGDRegressor(max_iter=1000, tol=1e-3, random_state=42),
            scaler=StandardScaler(),
        ))

        try:
            import numpy as np
            X_np = np.array(X, dtype=float)
            y_np = np.array(y, dtype=float)
            X_s  = entry.scaler.fit_transform(X_np)
            entry.model.fit(X_s, y_np)
            entry.r2          = float(entry.model.score(X_s, y_np))
            entry.n           = len(buf)
            entry.last_update = int(time.time() * 1000)
            entry.se_mean     = float(np.std(y_np) / np.sqrt(len(y_np)))
            self._save_model(strategy_type)
            logger.info("Retrained %s  n=%d  R²=%.3f", strategy_type, entry.n, entry.r2)
            return entry.r2 >= R2_GATE
        except Exception as exc:
            logger.warning("Retrain failed for %s: %s", strategy_type, exc)
            return False

    def predict(self, strategy_type: str, vpin: float, regime_tag: str) -> float | None:
        """
        Return a decay_rate recommendation ∈ DECAY_CLAMP, or None if the model
        is not yet confident enough (R² < R2_GATE or n < MIN_SAMPLES).
        """
        entry = self._models.get(strategy_type)
        if entry is None or entry.model is None:
            return None
        if entry.r2 < R2_GATE or entry.n < MIN_SAMPLES:
            return None
        try:
            import numpy as np
            features = np.array([[vpin, _REGIME_NUMERIC.get(regime_tag, 0.0)]], dtype=float)
            X_s      = entry.scaler.transform(features)
            raw      = float(entry.model.predict(X_s)[0])
            # Contract DECAY_CLAMP proportionally to outcome noise (SE of mean).
            # High SE → clamp contracts toward centre → conservative prediction.
            # SE shrinks with √n, so clamp opens up as more data accumulates.
            contraction = min(1.96 * entry.se_mean, (DECAY_CLAMP[1] - DECAY_CLAMP[0]) * 0.4)
            lo = DECAY_CLAMP[0] + contraction
            hi = DECAY_CLAMP[1] - contraction
            return float(np.clip(raw, lo, hi))
        except Exception as exc:
            logger.debug("predict failed for %s: %s", strategy_type, exc)
            return None

    def check_revert(self, strategy_type: str) -> bool:
        """
        Returns True if the post-push Sharpe has degraded enough to trigger revert.
        Call after at least REVERT_WINDOW new outcomes have arrived post-push.
        """
        scores = self._post_push_scores.get(strategy_type, [])
        if len(scores) < REVERT_WINDOW:
            return False
        before = self._sharpe_before.get(strategy_type)
        if before is None:
            return False
        mean = sum(scores) / len(scores)
        var  = sum((s - mean) ** 2 for s in scores) / len(scores)
        std  = math.sqrt(var) if var > 0 else 1e-9
        sharpe_after = mean / std
        degraded = sharpe_after < before * (1 - REVERT_SHARPE_DROP)
        if degraded:
            logger.warning(
                "Revert triggered for %s: Sharpe %.3f → %.3f (>%.0f%% drop)",
                strategy_type, before, sharpe_after, REVERT_SHARPE_DROP * 100,
            )
        return degraded

    def record_push(self, strategy_type: str, sharpe_at_push: float) -> None:
        """Call immediately after pushing a PHIC update for a strategy type."""
        self._sharpe_before[strategy_type] = sharpe_at_push
        self._post_push_scores[strategy_type] = []

    def get_insights(self) -> dict[str, dict]:
        """Return {strategy_type: {r2, n, buf_n, last_update_ms}} for dashboard display.

        Types that have accumulated samples but not yet reached MIN_SAMPLES are included
        with r2=0 and n=0 so the dashboard can show collection progress.
        """
        result: dict[str, dict] = {}
        # Trained models
        for st, e in self._models.items():
            result[st] = {
                "r2":             round(e.r2, 4),
                "n":              e.n,
                "buf_n":          len(self._buffers.get(st, [])),
                "min_samples":    MIN_SAMPLES,
                "last_update_ms": e.last_update,
                "se_mean":        round(e.se_mean, 4),
            }
        # Buffer-only types — still collecting
        for st, buf in self._buffers.items():
            if st not in result and buf:
                result[st] = {
                    "r2":             0.0,
                    "n":              0,
                    "buf_n":          len(buf),
                    "min_samples":    MIN_SAMPLES,
                    "last_update_ms": 0,
                }
        return result

    # ── Persistence ───────────────────────────────────────────────────────────

    def _save_model(self, strategy_type: str) -> None:
        try:
            import joblib
            path = os.path.join(self._model_dir, f"{strategy_type}.joblib")
            joblib.dump(self._models[strategy_type], path)
        except Exception as exc:
            logger.warning("Failed to save model for %s: %s", strategy_type, exc)

    def _load_models(self) -> None:
        try:
            import joblib
        except ImportError:
            return
        for fname in os.listdir(self._model_dir):
            if not fname.endswith(".joblib"):
                continue
            st = fname[:-7]
            try:
                self._models[st] = joblib.load(os.path.join(self._model_dir, fname))
                logger.info("Loaded model for %s  n=%d  R²=%.3f",
                            st, self._models[st].n, self._models[st].r2)
            except Exception as exc:
                logger.warning("Failed to load model %s: %s", fname, exc)
