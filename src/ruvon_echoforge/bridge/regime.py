"""
Gaussian HMM regime detector — 3 states: LowVol, HighVol, Crisis.

Uses an inline Gaussian HMM (numpy only, no hmmlearn dependency).
Observations are (vpin, latency_norm, momentum_norm) tuples.

The detector maintains a rolling 60-observation window and re-fits emission
parameters every 30 new observations using 3 iterations of Baum-Welch EM.
Regime inference uses the Viterbi algorithm on the current window.

Thread safety: all public methods are async-safe; Baum-Welch re-fit runs in
an executor thread so it never blocks the FastAPI event loop.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Callable

import numpy as np

logger = logging.getLogger(__name__)

REGIME_LABELS   = ["LowVol", "HighVol", "Crisis"]
RISK_BY_REGIME  = {"LowVol": 1.0, "HighVol": 0.7, "Crisis": 0.3}

_MIN_OBSERVATIONS   = 20   # window size before first Viterbi decode
_WINDOW_SIZE        = 60   # rolling observation window
_REFIT_EVERY        = 30   # re-run Baum-Welch every N new observations
_BAUM_WELCH_ITERS   = 3    # EM iterations (sufficient for 3-state model)


class RegimeDetector:
    """3-state Gaussian HMM over (vpin, latency_norm, momentum_norm)."""

    def __init__(self, on_transition: Callable[[str, float], None] | None = None) -> None:
        self._window: deque[tuple[float, float, float]] = deque(maxlen=_WINDOW_SIZE)
        self._obs_since_refit = 0
        self._current_regime  = "LowVol"
        self._confidence      = 0.0
        self._refit_task: asyncio.Task | None = None
        self.on_transition = on_transition  # callback(regime_tag, confidence)

        # ── Initial emission parameters ──────────────────────────────────────
        # Means per state: [vpin, latency_norm, momentum_norm]
        self._means = np.array([
            [0.15, 0.2,  0.0],   # LowVol  — low VPIN, fast latency, flat trend
            [0.40, 0.5,  0.3],   # HighVol — medium VPIN, moderate latency
            [0.72, 0.9,  0.6],   # Crisis  — high VPIN, degraded latency
        ])
        self._stds = np.array([
            [0.08, 0.15, 0.15],
            [0.10, 0.20, 0.20],
            [0.10, 0.15, 0.20],
        ])
        # Transition matrix — slight stickiness (regime persists)
        self._trans = np.array([
            [0.85, 0.12, 0.03],
            [0.10, 0.80, 0.10],
            [0.05, 0.15, 0.80],
        ])
        # Initial state distribution
        self._pi = np.array([0.6, 0.3, 0.1])

    # ── Public API ────────────────────────────────────────────────────────────

    @property
    def is_warm(self) -> bool:
        return len(self._window) >= _MIN_OBSERVATIONS

    @property
    def current_regime(self) -> str:
        return self._current_regime

    @property
    def confidence(self) -> float:
        return self._confidence

    def record_observation(self, vpin: float, latency_ms: float, momentum: float) -> None:
        """Add one observation and trigger inference if window is warm."""
        lat_norm = min(1.0, latency_ms / 200.0)       # normalise: 200ms → 1.0
        mom_norm = max(-1.0, min(1.0, momentum))       # already ~[-1,1]
        obs = (float(vpin), float(lat_norm), float(mom_norm))
        self._window.append(obs)
        self._obs_since_refit += 1

        if not self.is_warm:
            return

        # Schedule re-fit in background every _REFIT_EVERY observations
        if self._obs_since_refit >= _REFIT_EVERY:
            self._obs_since_refit = 0
            self._schedule_refit()

        # Infer regime synchronously (Viterbi is fast on a 60-obs window)
        new_regime, confidence = self._infer_regime()
        if new_regime != self._current_regime:
            old = self._current_regime
            self._current_regime = new_regime
            self._confidence     = confidence
            logger.info("Regime transition: %s → %s  confidence=%.2f", old, new_regime, confidence)
            if self.on_transition:
                self.on_transition(new_regime, confidence)

    # ── Internal ─────────────────────────────────────────────────────────────

    def _emission_log_probs(self, obs: np.ndarray) -> np.ndarray:
        """Log-probability of obs under each state's Gaussian emission."""
        # obs shape: (T, D),  means/stds: (K, D)
        T, D = obs.shape
        K    = len(REGIME_LABELS)
        log_p = np.zeros((T, K))
        for k in range(K):
            diff     = obs - self._means[k]
            exponent = -0.5 * np.sum((diff / self._stds[k]) ** 2, axis=1)
            log_norm = -0.5 * D * np.log(2 * np.pi) - np.sum(np.log(self._stds[k]))
            log_p[:, k] = exponent + log_norm
        return log_p

    def _infer_regime(self) -> tuple[str, float]:
        """Viterbi decode — returns (regime_label, confidence)."""
        obs   = np.array(list(self._window))
        T, K  = len(obs), len(REGIME_LABELS)
        log_b = self._emission_log_probs(obs)
        log_a = np.log(self._trans + 1e-12)
        log_pi = np.log(self._pi + 1e-12)

        delta = np.full((T, K), -np.inf)
        psi   = np.zeros((T, K), dtype=int)
        delta[0] = log_pi + log_b[0]

        for t in range(1, T):
            for j in range(K):
                v         = delta[t - 1] + log_a[:, j]
                psi[t, j] = int(np.argmax(v))
                delta[t, j] = v[psi[t, j]] + log_b[t, j]

        # Backtrace
        path = np.zeros(T, dtype=int)
        path[-1] = int(np.argmax(delta[-1]))
        for t in range(T - 2, -1, -1):
            path[t] = psi[t + 1, path[t + 1]]

        final_state = int(path[-1])
        # Softmax of last delta for confidence
        last = delta[-1] - np.max(delta[-1])
        probs = np.exp(last) / np.sum(np.exp(last))
        return REGIME_LABELS[final_state], float(probs[final_state])

    def _schedule_refit(self) -> None:
        """Launch Baum-Welch EM in an executor thread."""
        if self._refit_task and not self._refit_task.done():
            return  # previous refit still running
        try:
            loop = asyncio.get_event_loop()
            obs  = np.array(list(self._window))
            self._refit_task = loop.run_in_executor(None, self._baum_welch, obs)
        except RuntimeError:
            pass  # no running event loop (e.g. during tests)

    def _baum_welch(self, obs: np.ndarray) -> None:
        """Simplified Baum-Welch EM — 3 iterations, updates means/stds in-place."""
        T, D = obs.shape
        K    = len(REGIME_LABELS)
        means = self._means.copy()
        stds  = self._stds.copy()
        trans = self._trans.copy()
        pi    = self._pi.copy()

        for _ in range(_BAUM_WELCH_ITERS):
            # ── E-step: forward-backward ──────────────────────────────────────
            log_b = np.zeros((T, K))
            for k in range(K):
                diff      = obs - means[k]
                exponent  = -0.5 * np.sum((diff / stds[k]) ** 2, axis=1)
                log_norm  = -0.5 * D * np.log(2 * np.pi) - np.sum(np.log(stds[k]))
                log_b[:, k] = exponent + log_norm
            b = np.exp(log_b - log_b.max(axis=1, keepdims=True))
            b = np.clip(b, 1e-300, None)

            # Forward
            alpha = np.zeros((T, K))
            alpha[0] = pi * b[0]
            alpha[0] /= alpha[0].sum() + 1e-300
            for t in range(1, T):
                alpha[t] = (alpha[t - 1] @ trans) * b[t]
                alpha[t] /= alpha[t].sum() + 1e-300

            # Backward
            beta = np.zeros((T, K))
            beta[-1] = 1.0
            for t in range(T - 2, -1, -1):
                beta[t] = trans @ (b[t + 1] * beta[t + 1])
                beta[t] /= beta[t].sum() + 1e-300

            gamma = alpha * beta
            gamma /= gamma.sum(axis=1, keepdims=True) + 1e-300

            xi = np.zeros((T - 1, K, K))
            for t in range(T - 1):
                xi[t] = (alpha[t, :, None] * trans * b[t + 1] * beta[t + 1])
                xi[t] /= xi[t].sum() + 1e-300

            # ── M-step ────────────────────────────────────────────────────────
            pi    = gamma[0] / (gamma[0].sum() + 1e-300)
            trans = xi.sum(axis=0) / (xi.sum(axis=0).sum(axis=1, keepdims=True) + 1e-300)
            for k in range(K):
                w         = gamma[:, k]
                w_sum     = w.sum() + 1e-300
                means[k]  = (w[:, None] * obs).sum(axis=0) / w_sum
                diff      = obs - means[k]
                stds[k]   = np.sqrt((w[:, None] * diff ** 2).sum(axis=0) / w_sum)
                stds[k]   = np.clip(stds[k], 0.02, None)  # prevent collapse

        # Commit updates (only if the new means are ordered by VPIN — prevents state swap)
        if means[0, 0] < means[1, 0] < means[2, 0]:
            self._means = means
            self._stds  = stds
            self._trans = trans
            self._pi    = pi
            logger.debug("Baum-Welch refit accepted — means: %s", means[:, 0].round(3))
        else:
            logger.debug("Baum-Welch refit rejected (state order violated) — keeping prior")
