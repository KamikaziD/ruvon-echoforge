"""
EchoForge workflow step functions.

Three workflows: EchoForgePHICUpdate, EchoForgeModelRetrain, EchoForgeEmergencyFreeze.

Each step function follows the Ruvon signature:
    def step(state: BaseModel, context: StepContext, **user_input) -> dict

The EchoForgeExtension instance is registered via register_extension() before
workflows run, then retrieved by _extension() in each step.  Tests call
register_extension("default", mock_ext) before exercising steps.
"""

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel
from ruvon.models import StepContext, WorkflowJumpDirective

logger = logging.getLogger(__name__)

# Module-level extension registry — populated by the agent at startup.
# Key: workflow_id or "default".  Value: EchoForgeExtension instance.
_EXTENSION_REGISTRY: dict[str, Any] = {}


def register_extension(ext, key: str = "default") -> None:
    """Register an EchoForgeExtension so workflow steps can retrieve it."""
    _EXTENSION_REGISTRY[key] = ext


def unregister_extension(key: str = "default") -> None:
    """Remove a registered extension (useful in tests for cleanup)."""
    _EXTENSION_REGISTRY.pop(key, None)


# ── State models ──────────────────────────────────────────────────────────────

class PHICUpdateState(BaseModel):
    config:      dict  = {}
    validated:   bool  = False
    applied_at:  str   = ""
    reject_reason: str = ""


class ModelRetrainState(BaseModel):
    pair:           str   = "BTC/USDT"
    lookback_days:  int   = 3
    onnx_bytes:     bytes = b""
    samples:        int   = 0
    accuracy:       float = 0.0
    positive_rate:  float = 0.0
    trained_at:     str   = ""


class EmergencyFreezeState(BaseModel):
    vpin:              float = 0.0
    regime_tag:        str   = "LowVol"
    severity:          float = 0.0
    freeze_applied:    bool  = False
    orders_cancelled:  int   = 0
    resumed:           bool  = False
    vpin_crisis_threshold: float = 0.70
    vpin_highvol_threshold: float = 0.40


# ── Helper ────────────────────────────────────────────────────────────────────

def _extension(context: StepContext):
    """Retrieve the EchoForgeExtension from the registry."""
    ext = _EXTENSION_REGISTRY.get(context.workflow_id) or _EXTENSION_REGISTRY.get("default")
    if ext is None:
        raise RuntimeError(
            "EchoForgeExtension not registered. "
            "Call ruvon_echoforge.workflows.steps.register_extension(ext) before running workflows."
        )
    return ext


# ── EchoForgePHICUpdate steps ─────────────────────────────────────────────────

def validate_phic_config(state: PHICUpdateState, context: StepContext, **kwargs) -> dict:
    """Reject configs that disable all patterns simultaneously."""
    config = dict(state.config or {})

    # All patterns vetoed AND autonomy zeroed = complete lockout — reject it
    all_patterns = {"MOMENTUM_V1", "DEPTH_GRAB", "REVERSION_A", "SPREAD_FADE"}
    vetoed = set(config.get("vetoed_patterns") or [])
    autonomy = float(config.get("autonomy_level", 1.0))

    if vetoed >= all_patterns and autonomy == 0.0:
        logger.warning("[EchoForge] PHIC config rejected — all patterns vetoed with zero autonomy")
        raise WorkflowJumpDirective("DONE")

    return {"validated": True}


def apply_phic_config(state: PHICUpdateState, context: StepContext, **kwargs) -> dict:
    """Push validated PHIC config to JS workers via EchoForgeExtension."""
    import asyncio
    ext = _extension(context)
    asyncio.run(ext.push_phic_config(dict(state.config)))
    applied_at = datetime.now(timezone.utc).isoformat()
    logger.info("[EchoForge] PHIC config applied at %s", applied_at)
    return {"applied_at": applied_at}


def notify_phic_applied(state: PHICUpdateState, context: StepContext, **kwargs) -> dict:
    """Publish applied config event to NATS (FIRE_AND_FORGET — non-critical)."""
    try:
        import asyncio
        ext = _extension(context)
        msg = {"type": "phic_applied", "applied_at": state.applied_at, "config": state.config}
        asyncio.run(ext._on_telemetry(msg))
    except Exception as exc:
        logger.debug("[EchoForge] notify_phic_applied failed (non-critical): %s", exc)
    return {}


# ── EchoForgeModelRetrain steps ───────────────────────────────────────────────

def fetch_training_data(state: ModelRetrainState, context: StepContext, **kwargs) -> dict:
    """Pull Binance klines and build the 8-feature training matrix."""
    import numpy as np
    import httpx

    pair   = state.pair.replace("/", "").upper()  # "BTC/USDT" → "BTCUSDT"
    days   = max(1, min(30, state.lookback_days))
    limit  = days * 24 * 60  # 1-minute klines for lookback period
    limit  = min(limit, 1000)  # Binance max per request

    url = f"https://api.binance.com/api/v3/klines?symbol={pair}&interval=1m&limit={limit}"
    logger.info("[EchoForge] Fetching %d klines for %s", limit, pair)

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(url)
        resp.raise_for_status()
        klines = resp.json()
    except Exception as exc:
        logger.warning("[EchoForge] Binance fetch failed (%s) — using synthetic data", exc)
        rng = np.random.default_rng(42)
        n = limit
        return {
            "samples": n,
            "_X": rng.standard_normal((n, 8)).tolist(),
            "_y": rng.integers(0, 2, n).tolist(),
        }

    # Build feature matrix from OHLCV
    prices  = np.array([float(k[4]) for k in klines])  # close
    volumes = np.array([float(k[5]) for k in klines])

    # 8 features matching inference_worker.js
    n = len(prices)
    momentum     = np.diff(prices, prepend=prices[0]) / np.maximum(prices, 1)
    ema_fast     = _ewma(prices, 0.2)
    ema_slow     = _ewma(prices, 0.05)
    z_mean       = np.convolve(prices, np.ones(30)/30, mode="same")
    z_std        = np.array([prices[max(0,i-29):i+1].std() or 1 for i in range(n)])
    z_score      = (prices - z_mean) / z_std
    vwap         = np.cumsum(prices * volumes) / np.maximum(np.cumsum(volumes), 1e-9)
    vwap_dev     = (prices - vwap) / np.maximum(vwap, 1)
    imbalance    = np.zeros(n)  # not available from klines; use zero
    vol_ratio    = np.log(np.maximum(volumes, 1e-9) / np.maximum(np.mean(volumes), 1e-9))
    spread_norm  = np.abs(momentum) * 0.5  # proxy (actual spread not in klines)
    ema_fast_dev = (ema_fast - prices) / np.maximum(prices, 1)
    ema_slow_dev = (ema_slow - prices) / np.maximum(prices, 1)

    X = np.column_stack([momentum, z_score, vwap_dev, imbalance,
                         vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev])
    # Label: did price go up in the next bar?
    y = (np.roll(prices, -1) > prices).astype(int)
    y[-1] = 0  # last bar has no "next"

    return {"samples": n, "_X": X.tolist(), "_y": y.tolist()}


def train_onnx_model(state: ModelRetrainState, context: StepContext, **kwargs) -> dict:
    """Fit sklearn MLP with class balancing and convert to ONNX."""
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    X = np.array(kwargs.get("_X") or state.__dict__.get("_X", []), dtype=float)
    y = np.array(kwargs.get("_y") or state.__dict__.get("_y", []), dtype=int)

    if len(X) == 0:
        raise ValueError("No training data available — fetch_training_data must run first")

    # Class-weight balancing (prevents always-predicting-down on imbalanced labels)
    pos_rate = float(y.mean())
    if 0 < pos_rate < 1:
        w = np.where(y == 1, (1 - pos_rate) / pos_rate, 1.0)
    else:
        w = np.ones(len(y))

    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp",    MLPClassifier(
            hidden_layer_sizes=(32, 16),
            activation="relu",
            solver="adam",
            max_iter=300,
            random_state=0,
            alpha=0.001,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=10,
        )),
    ])
    pipe.fit(X, y, mlp__sample_weight=w)

    accuracy     = float(pipe.score(X, y))
    initial_type = [("float_input", FloatTensorType([None, 8]))]
    onnx_model   = convert_sklearn(pipe, initial_types=initial_type,
                                   target_opset=17, options={"zipmap": False})
    onnx_bytes   = onnx_model.SerializeToString()
    trained_at   = datetime.now(timezone.utc).isoformat()

    logger.info("[EchoForge] Model trained: samples=%d accuracy=%.3f pos_rate=%.3f onnx=%dKB",
                len(y), accuracy, pos_rate, len(onnx_bytes) // 1024)
    return {
        "onnx_bytes":    onnx_bytes,
        "accuracy":      round(accuracy, 4),
        "positive_rate": round(pos_rate, 4),
        "trained_at":    trained_at,
    }


def hot_swap_inference_model(state: ModelRetrainState, context: StepContext, **kwargs) -> dict:
    """Push new ONNX model bytes to inference_worker via EchoForgeExtension."""
    import asyncio
    ext = _extension(context)
    if not state.onnx_bytes:
        raise ValueError("onnx_bytes is empty — train_onnx_model must succeed first")
    asyncio.run(ext.hot_swap_model(state.onnx_bytes))
    logger.info("[EchoForge] Model hot-swapped into inference_worker")
    return {}


def log_retrain_outcome(state: ModelRetrainState, context: StepContext, **kwargs) -> dict:
    """Publish retrain outcome to NATS for monitoring (FIRE_AND_FORGET)."""
    try:
        import asyncio
        ext = _extension(context)
        msg = {
            "type":          "model_retrained",
            "samples":       state.samples,
            "accuracy":      state.accuracy,
            "positive_rate": state.positive_rate,
            "trained_at":    state.trained_at,
        }
        asyncio.run(ext._on_telemetry(msg))
    except Exception as exc:
        logger.debug("[EchoForge] log_retrain_outcome failed (non-critical): %s", exc)
    return {}


# ── EchoForgeEmergencyFreeze steps ────────────────────────────────────────────

def evaluate_freeze_severity(state: EmergencyFreezeState, context: StepContext, **kwargs) -> dict:
    """DECISION: freeze if VPIN > crisis threshold AND regime is Crisis."""
    vpin    = state.vpin
    regime  = state.regime_tag
    crisis  = state.vpin_crisis_threshold

    if vpin > crisis and regime == "Crisis":
        logger.warning("[EchoForge] FREEZE triggered: VPIN=%.3f regime=%s", vpin, regime)
        return {"severity": min(vpin, 1.0)}

    if vpin > state.vpin_highvol_threshold:
        logger.info("[EchoForge] Elevated VPIN=%.3f (below crisis) — no freeze", vpin)

    # Not severe enough — skip FreezeEngine
    logger.info("[EchoForge] Freeze not warranted (VPIN=%.3f regime=%s)", vpin, regime)
    raise WorkflowJumpDirective("DONE")


def freeze_echoforge_engine(state: EmergencyFreezeState, context: StepContext, **kwargs) -> dict:
    """Set emergency_freeze=true across all JS workers."""
    import asyncio
    ext = _extension(context)
    asyncio.run(ext.emergency_freeze())
    logger.warning("[EchoForge] Engine FROZEN (VPIN=%.3f)", state.vpin)
    return {"freeze_applied": True}


def cancel_all_open_orders(state: EmergencyFreezeState, context: StepContext, **kwargs) -> dict:
    """Cancel open orders via SyncManager SAF."""
    import asyncio
    ext = _extension(context)
    cancel_msg = {"type": "cancel_all", "reason": "emergency_freeze",
                  "vpin": state.vpin, "regime_tag": state.regime_tag}
    asyncio.run(ext._on_telemetry(cancel_msg))
    logger.info("[EchoForge] Cancel-all order issued")
    return {"orders_cancelled": 1}


def attempt_resume(state: EmergencyFreezeState, context: StepContext, **kwargs) -> dict:
    """After cool-down, clear freeze if VPIN has recovered."""
    import asyncio
    # Read current VPIN from kwargs if available (passed by caller as user_input)
    current_vpin = float(kwargs.get("current_vpin", state.vpin))
    if current_vpin < state.vpin_highvol_threshold:
        ext = _extension(context)
        asyncio.run(ext.emergency_resume())
        logger.info("[EchoForge] Engine RESUMED — VPIN=%.3f cleared", current_vpin)
        return {"resumed": True}

    logger.warning("[EchoForge] Resume skipped — VPIN=%.3f still elevated", current_vpin)
    return {"resumed": False}


# ── Helper ────────────────────────────────────────────────────────────────────

def _ewma(arr, alpha):
    """Exponential weighted moving average."""
    import numpy as np
    out = np.empty_like(arr)
    out[0] = arr[0]
    for i in range(1, len(arr)):
        out[i] = alpha * arr[i] + (1 - alpha) * out[i - 1]
    return out
