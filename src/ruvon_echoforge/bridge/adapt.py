"""
Adapt endpoints — calibrate thresholds, retrain signal model, tune decay parameters,
pretrain on historical data, discover patterns via Ollama.

These are extracted from tests/mock_valr/server.py so the production bridge can serve
them without depending on the mock server. The computation logic is identical.
"""

import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(tags=["adapt"])

# ── Suggestion cache — updated by adapt runs, replayed by /adapt/push-suggestions ─
_latest_suggestions: list[dict] = []


def _cache_suggestions(suggestions: list[dict]) -> None:
    """Store adapt-run suggestions so push-suggestions can replay them."""
    global _latest_suggestions
    if suggestions:
        _latest_suggestions = suggestions
        logger.info("Cached %d PHIC suggestions for push replay", len(suggestions))


# ── Request / response models ─────────────────────────────────────────────


class OutcomeRecord(BaseModel):
    features:   list[float]
    outcome:    int           # 1 = profitable fill, 0 = loss
    pnl:        float
    pattern_id: str
    regime_tag: str
    p_up:       float
    timestamp:  int


class TuneRequest(BaseModel):
    session:        dict
    decay_range:    list[float] = [0.005, 0.20, 12]
    loss_range:     list[float] = [2.0,  10.0,  12]
    survival_floor: float       = 0.30
    top_n:          int         = 5


class ReplayTuneRequest(BaseModel):
    """
    Proper per-echo replay tuner — mirrors the JS aliveness dynamics exactly.
    Accepts a full session JSON exported from session_recorder.js.
    Searches a 4-D grid: decay_rate × loss_mult × min_consensus × signal_boost.
    """
    session:              dict
    decay_range:          list[float] = [0.06, 0.20, 8]   # floor matches DECAY_BY_TYPE arb minimum
    loss_range:           list[float] = [2.0,  8.0,  8]
    consensus_range:      list[float] = [0.40, 0.70, 4]   # min_consensus_pct / 100
    signal_boost_range:   list[float] = [0.02, 0.06, 3]
    top_n:                int         = 5
    survival_floor:       float       = 0.30               # fraction of echoes that must survive


class PretrainRequest(BaseModel):
    lookback_days:  int   = 3
    forward_bars:   int   = 5
    min_edge_pct:   float = 0.001
    symbol:         str   = "BTCUSDT"
    n_features:     int   = 13


class DiscoverRequest(BaseModel):
    fills:        list[dict]
    current_phic: dict = {}
    ollama_url:   str  = "http://localhost:11434"
    model:        str  = "gemma4:e2b"


class TrainOfiRequest(BaseModel):
    l2_sequences: list[list[float]]  # each row: [delta_bid_L1..L5, delta_ask_L1..L5, vpin, spread_norm]
    outcomes:     list[int]          # 1 = price moved up, 0 = down, within forward_ms
    forward_ms:   int   = 200
    n_features:   int   = 12


# ── Endpoints ─────────────────────────────────────────────────────────────


@router.post("/adapt/calibrate-thresholds")
async def calibrate_thresholds(req: dict):
    """
    Compute VPIN regime thresholds from empirical samples collected by the browser.
    Uses p75 for HighVol and p95 for Crisis — reflects observed distribution.
    """
    import numpy as np

    samples = req.get("samples", [])
    if len(samples) < 30:
        return JSONResponse({"error": "Need at least 30 samples"}, status_code=400)
    arr = np.clip(np.array(samples, dtype=float), 0, 1)
    percentiles = {f"p{p}": float(np.percentile(arr, p)) for p in [25, 50, 75, 90, 95, 99]}
    highvol = float(np.percentile(arr, 75))
    crisis  = float(np.percentile(arr, 95))
    logger.info("Calibration: %d samples  HighVol=%.3f  Crisis=%.3f", len(arr), highvol, crisis)
    result = {
        "vpin_highvol_threshold": round(highvol, 4),
        "vpin_crisis_threshold":  round(crisis,  4),
        "sample_count": len(arr),
        **percentiles,
    }
    # Cache as PHIC suggestions when thresholds are meaningfully different from defaults
    if abs(highvol - 0.35) > 0.05 or abs(crisis - 0.65) > 0.05:
        _cache_suggestions([{
            "type": "threshold_calibration",
            "pattern": "ALL",
            "reason": f"Calibrated from {len(arr)} samples: HighVol={highvol:.3f} Crisis={crisis:.3f}",
            "suggested_change": {
                "vpin_highvol_threshold": result["vpin_highvol_threshold"],
                "vpin_crisis_threshold":  result["vpin_crisis_threshold"],
            },
        }])
    return result


@router.post("/adapt/retrain")
async def retrain_model(outcomes: list[OutcomeRecord]):
    """
    Retrain the signal model on real fill outcomes and return updated ONNX bytes.
    Blends real outcomes (5× weight) with a fresh 3k-sample synthetic baseline.
    """
    loop = asyncio.get_event_loop()
    try:
        onnx_bytes = await loop.run_in_executor(None, _do_retrain, outcomes)
    except Exception as exc:
        logger.exception("Retrain failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)
    return Response(content=onnx_bytes, media_type="application/octet-stream")


@router.post("/adapt/tune-decay")
async def tune_decay(req: TuneRequest):
    """
    Grid-search optimal (decay_rate, loss_multiplier) from a session export.
    Uses the exact EWMA formula from echoforge_worker.js.
    """
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_decay_grid, req)
    except Exception as exc:
        logger.warning("tune_decay failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)
    # Cache as PHIC suggestion when a best result is found
    best = result.get("best")
    if best and best.get("sharpe", 0) > 0:
        _cache_suggestions([{
            "type": "decay_tune",
            "pattern": "ALL",
            "reason": (f"Optimal decay={best['decay_rate']:.4f} loss_mult={best['loss_multiplier']:.2f} "
                       f"sharpe={best['sharpe']:.3f} wr={best['win_rate']*100:.0f}%"),
            "suggested_change": {
                "decay_rate":      best["decay_rate"],
                "loss_multiplier": best["loss_multiplier"],
            },
        }])
    return JSONResponse(content=result)


@router.post("/adapt/replay-tune")
async def replay_tune(req: ReplayTuneRequest):
    """
    Per-echo replay tuner — searches decay_rate, loss_mult, min_consensus, signal_boost
    using a full session export. Simulation mirrors the fixed JS gate logic exactly:
    gate checked BEFORE signal_boost is applied, separate aliveness per (pattern, regime).
    """
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_replay_tune, req)
    except Exception as exc:
        logger.warning("replay_tune failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)

    best = result.get("best")
    if best and best.get("sharpe", 0) > 0:
        _cache_suggestions([{
            "type": "replay_tune",
            "pattern": "ALL",
            "reason": (
                f"Replay-tuned: decay={best['decay_rate']:.4f} "
                f"loss_mult={best['loss_multiplier']:.2f} "
                f"consensus={best['min_consensus']:.2f} "
                f"boost={best['signal_boost']:.3f} "
                f"sharpe={best['sharpe']:.3f} wr={best['win_rate']*100:.0f}% n={best['executions']}"
            ),
            "suggested_change": {
                "decay_rate":        best["decay_rate"],
                "loss_multiplier":   best["loss_multiplier"],
                "min_consensus_pct": round(best["min_consensus"] * 100),
                "signal_boost":      best["signal_boost"],
            },
        }])
    return JSONResponse(content=result)


@router.post("/adapt/pretrain-historical")
async def pretrain_historical(req: PretrainRequest):
    """
    Fetch real Binance 1-minute klines, compute the 8–13 ONNX features used at
    inference time, label with forward price movement, train MLP, return ONNX bytes.
    """
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _do_pretrain_historical, req)
    except Exception as exc:
        logger.error("pretrain-historical failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)
    return JSONResponse(content=result)


@router.post("/adapt/discover")
async def discover_patterns(req: DiscoverRequest):
    """Analyse fill history with Ollama to surface profitable conditions and name new patterns."""
    if len(req.fills) < 5:
        return JSONResponse(content={"discoveries": []})
    loop = asyncio.get_event_loop()
    try:
        discoveries = await loop.run_in_executor(
            None, _call_ollama_discover, req.fills, req.current_phic, req.ollama_url, req.model
        )
    except Exception as exc:
        logger.warning("discover_patterns failed: %s", exc)
        return JSONResponse(content={"discoveries": []})
    return JSONResponse(content={"discoveries": discoveries})


# ── Computation functions (pure, run in executor) ─────────────────────────


def _do_retrain(outcomes: list[OutcomeRecord]) -> bytes:
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    rng    = np.random.default_rng(42)
    N_SYN  = 3_000

    n_real_feat = outcomes[0].features.__len__() if outcomes else 13
    n_target    = max(n_real_feat, 13)

    momentum     = rng.laplace(0, 0.0015,   N_SYN)
    z_score      = rng.normal(0, 1.2,       N_SYN)
    vwap_dev     = rng.normal(0, 0.0015,    N_SYN)
    imbalance    = rng.uniform(-1, 1,       N_SYN)
    vol_ratio    = np.clip(rng.normal(0, 0.3, N_SYN), -1, 1)
    spread_norm  = rng.exponential(0.00015, N_SYN)
    ema_fast_dev = rng.normal(0, 0.001,     N_SYN)
    ema_slow_dev = rng.normal(0, 0.0015,    N_SYN)

    X_syn8  = np.column_stack([momentum, z_score, vwap_dev, imbalance,
                                vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev])
    X_syn11 = np.column_stack([X_syn8, np.zeros((N_SYN, 3))])
    sentiment_score    = np.clip(rng.normal(0, 0.3, N_SYN), -1, 1)
    sentiment_momentum = np.clip(rng.normal(0, 0.1, N_SYN), -1, 1)
    X_syn13 = np.column_stack([X_syn11, sentiment_score, sentiment_momentum])
    extra   = n_target - 13
    X_syn   = np.column_stack([X_syn13, np.zeros((N_SYN, extra))]) if extra > 0 else X_syn13

    signal = (
         2.5 * np.tanh(momentum  * 600)  +
        -1.2 * np.tanh(z_score   * 0.7)  +
         0.8 * np.tanh(vwap_dev  * 400)  +
         0.7 * np.tanh(imbalance * 3.0)  +
         0.6 * np.tanh(vol_ratio * 3.0)  +
        -0.3 * spread_norm * 1000        +
         0.5 * np.tanh(ema_fast_dev * 800) +
         0.3 * np.tanh(ema_slow_dev * 600) +
         0.4 * np.tanh(sentiment_score * 3.0)
    )
    y_syn = (signal + rng.normal(0, 0.9, N_SYN) > 0).astype(int)

    if outcomes:
        X_real = np.array([o.features for o in outcomes], dtype=float)
        y_real = np.array([o.outcome  for o in outcomes], dtype=int)
        if X_real.shape[1] < n_target:
            X_real = np.column_stack([X_real, np.zeros((len(X_real), n_target - X_real.shape[1]))])
        X_real = np.tile(X_real, (5, 1))
        y_real = np.tile(y_real, 5)
        X = np.vstack([X_syn, X_real])
        y = np.concatenate([y_syn, y_real])
    else:
        X, y = X_syn, y_syn

    n_feat = X.shape[1]
    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp",    MLPClassifier(
            hidden_layer_sizes=(64, 32, 16), activation="relu", solver="adam",
            max_iter=300, random_state=0, alpha=0.001,
            early_stopping=True, validation_fraction=0.1, n_iter_no_change=10,
        )),
    ])
    pipe.fit(X, y)

    initial_type = [("float_input", FloatTensorType([None, n_feat]))]
    onnx_model   = convert_sklearn(pipe, initial_types=initial_type,
                                   target_opset=17, options={"zipmap": False})
    onnx_bytes   = onnx_model.SerializeToString()
    logger.info("Retrain: %d real + %d synthetic → %d KB  features=%d",
                len(outcomes), N_SYN, len(onnx_bytes) // 1024, n_feat)
    return onnx_bytes


def _run_decay_grid(req: TuneRequest) -> dict:
    import math as _math
    from collections import defaultdict, deque
    from itertools import product as _product

    MIN_ALIVENESS = 0.30
    SIGNAL_BOOST  = 0.03

    decisions = req.session.get("decisions", [])
    outcomes  = req.session.get("outcomes",  [])

    if not decisions:
        return {"error": "no decisions in session", "best": None, "top": []}

    def _linspace(lo, hi, n):
        n = int(n)
        if n == 1:
            return [lo]
        return [round(lo + (hi - lo) / (n - 1) * i, 6) for i in range(n)]

    def _simulate(decay_rate, loss_mult):
        fifo: dict = defaultdict(deque)
        for o in outcomes:
            pid   = o.get("pattern_id")
            score = o.get("outcome_score")
            if pid and score is not None:
                fifo[pid].append(float(score))

        aliveness = 0.50
        scores, passed, dropped = [], 0, 0

        for d in decisions:
            if d.get("result") != "pass":
                dropped += 1
                continue
            aliveness = min(1.0, aliveness + SIGNAL_BOOST)
            if aliveness < MIN_ALIVENESS:
                dropped += 1
                continue
            passed += 1
            pid = d.get("pattern_id")
            if pid and fifo[pid]:
                sc = fifo[pid].popleft()
                scores.append(sc)
                normalised = (sc + 1.0) / 2.0
                alpha      = min(decay_rate * loss_mult, 1.0) if sc < 0 else decay_rate
                aliveness  = max(0.0, min(1.0, aliveness * (1 - alpha) + normalised * alpha))

        total     = passed + dropped
        pass_rate = passed / total if total > 0 else 0.0
        win_rate  = sum(1 for s in scores if s > 0) / len(scores) if scores else 0.0
        mean      = sum(scores) / len(scores) if scores else 0.0
        var       = sum((s - mean) ** 2 for s in scores) / len(scores) if scores else 0.0
        sharpe    = mean / _math.sqrt(var) if var > 0 else 0.0
        survival  = float(aliveness >= MIN_ALIVENESS)
        return {"decay_rate": decay_rate, "loss_multiplier": loss_mult,
                "sharpe": round(sharpe, 6), "win_rate": round(win_rate, 6),
                "pass_rate": round(pass_rate, 6), "echo_survival": round(survival, 6),
                "executions": len(scores)}

    dr_lo, dr_hi, dr_n = req.decay_range[0], req.decay_range[1], req.decay_range[2]
    lm_lo, lm_hi, lm_n = req.loss_range[0],  req.loss_range[1],  req.loss_range[2]
    decay_vals  = _linspace(dr_lo, dr_hi, dr_n)
    loss_vals   = _linspace(lm_lo, lm_hi, lm_n)
    all_results = [_simulate(dr, lm) for dr, lm in _product(decay_vals, loss_vals)]

    viable = [r for r in all_results
              if r["echo_survival"] >= req.survival_floor and r["executions"] > 0]
    if not viable:
        viable = [r for r in all_results if r["executions"] > 0] or all_results

    viable.sort(key=lambda r: r["sharpe"], reverse=True)
    best = viable[0] if viable else None

    if best:
        logger.info("Decay tune: best decay=%.4f loss_mult=%.2f sharpe=%.4f wr=%.1f%% n=%d",
                    best["decay_rate"], best["loss_multiplier"], best["sharpe"],
                    best["win_rate"] * 100, best["executions"])

    return {
        "best":       best,
        "top":        viable[:req.top_n],
        "grid_cells": len(all_results),
        "decisions":  len(decisions),
        "outcomes":   len(outcomes),
    }


def _fetch_klines(symbol: str, interval: str, limit: int, end_time_ms: int | None = None) -> list:
    import requests as _req
    params: dict = {"symbol": symbol, "interval": interval, "limit": limit}
    if end_time_ms:
        params["endTime"] = end_time_ms
    r = _req.get("https://api.binance.com/api/v3/klines", params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def _do_pretrain_historical(req: PretrainRequest) -> dict:
    import base64 as _b64
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    bars_needed = req.lookback_days * 24 * 60 + req.forward_bars + 50
    all_klines: list = []
    end_time = None
    while len(all_klines) < bars_needed:
        batch = _fetch_klines(req.symbol, "1m", 1000, end_time)
        if not batch:
            break
        all_klines = batch + all_klines
        end_time = int(batch[0][0]) - 1
        if len(batch) < 1000:
            break

    if len(all_klines) < req.forward_bars + 30:
        raise RuntimeError(f"Only {len(all_klines)} klines — Binance may be unreachable")

    logger.info("pretrain-historical: %d klines for %s", len(all_klines), req.symbol)

    closes  = np.array([float(k[4]) for k in all_klines])
    highs   = np.array([float(k[2]) for k in all_klines])
    lows    = np.array([float(k[3]) for k in all_klines])
    volumes = np.array([float(k[5]) for k in all_klines])
    taker_buy_vol = np.array([float(k[9]) for k in all_klines])
    n = len(closes)

    α_fast, α_slow = 0.18, 0.09
    ema_fast = np.zeros(n); ema_fast[0] = closes[0]
    ema_slow = np.zeros(n); ema_slow[0] = closes[0]
    for i in range(1, n):
        ema_fast[i] = ema_fast[i-1] + α_fast * (closes[i] - ema_fast[i-1])
        ema_slow[i] = ema_slow[i-1] + α_slow * (closes[i] - ema_slow[i-1])

    vwap = np.zeros(n)
    for i in range(n):
        w     = max(0, i - 29)
        v_sum = np.sum(volumes[w:i+1])
        vwap[i] = np.sum(closes[w:i+1] * volumes[w:i+1]) / v_sum if v_sum > 0 else closes[i]

    z_score = np.zeros(n)
    for i in range(29, n):
        w   = closes[i-29:i+1]
        std = np.std(w) or 1.0
        z_score[i] = (closes[i] - np.mean(w)) / std

    ewma_vol = np.zeros(n); ewma_vol[0] = volumes[0]
    for i in range(1, n):
        ewma_vol[i] = ewma_vol[i-1] * 0.95 + volumes[i] * 0.05

    momentum     = (ema_fast - ema_slow) / np.where(ema_slow > 0, ema_slow, 1)
    vwap_dev     = np.where(vwap > 0, (vwap - closes) / vwap, 0)
    imbalance    = np.where(volumes > 0, (taker_buy_vol / volumes - 0.5) * 2, 0)
    vol_ratio    = np.where(ewma_vol > 0, np.clip((volumes - ewma_vol) / ewma_vol, -1, 1), 0)
    spread_norm  = (highs - lows) / np.where(closes > 0, closes, 1)
    ema_fast_dev = (ema_fast - closes) / np.where(closes > 0, closes, 1)
    ema_slow_dev = (ema_slow - closes) / np.where(closes > 0, closes, 1)

    start = 30
    end   = n - req.forward_bars
    idx   = np.arange(start, end)

    fwd_return = (closes[idx + req.forward_bars] - closes[idx]) / closes[idx]
    y = (fwd_return > req.min_edge_pct).astype(int)

    X8 = np.column_stack([momentum[idx], z_score[idx], vwap_dev[idx], imbalance[idx],
                          vol_ratio[idx], spread_norm[idx], ema_fast_dev[idx], ema_slow_dev[idx]])
    X11 = np.column_stack([X8, np.zeros((len(idx), 3))]) if req.n_features >= 11 else X8
    X   = np.column_stack([X11, np.zeros((len(idx), 2))]) if req.n_features >= 13 else X11

    if len(np.unique(y)) < 2:
        raise RuntimeError("Labels are all one class — check min_edge_pct or data quality")

    logger.info("pretrain-historical: %d samples  label_rate=%.1f%%", len(y), y.mean() * 100)

    pos_rate = y.mean()
    w = np.where(y == 1, (1 - pos_rate) / pos_rate, 1.0) if 0 < pos_rate < 1 else np.ones(len(y))
    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp",    MLPClassifier(
            hidden_layer_sizes=(64, 32, 16), activation="relu", solver="adam",
            max_iter=500, random_state=42, alpha=0.0005,
            early_stopping=True, validation_fraction=0.1, n_iter_no_change=15,
        )),
    ])
    pipe.fit(X, y, mlp__sample_weight=w)
    accuracy = float(pipe.score(X, y))

    n_feat = X.shape[1]
    initial_type = [("float_input", FloatTensorType([None, n_feat]))]
    onnx_model   = convert_sklearn(pipe, initial_types=initial_type,
                                   target_opset=17, options={"zipmap": False})
    onnx_bytes   = onnx_model.SerializeToString()
    logger.info("pretrain-historical: %d KB  acc=%.1f%%  features=%d",
                len(onnx_bytes) // 1024, accuracy * 100, n_feat)
    return {
        "onnx_b64":      _b64.b64encode(onnx_bytes).decode(),
        "samples":       int(len(y)),
        "accuracy":      round(accuracy, 4),
        "positive_rate": round(float(y.mean()), 4),
        "n_features":    n_feat,
    }


_ALL_PATTERNS = {
    "MOMENTUM_V1", "DEPTH_GRAB", "REVERSION_A", "SPREAD_FADE",
    "SUPERTREND_CROSS", "WHALE_WAKE", "ARBI_CROSS_EXCHANGE", "VOLATILITY_BREAKOUT",
}

# Strategy type context for the LLM — mirrors nociceptor_worker.js STRATEGY_TYPE
_PATTERN_TYPES = {
    "MOMENTUM_V1":         "momentum",
    "DEPTH_GRAB":          "maker",
    "SUPERTREND_CROSS":    "trend",
    "WHALE_WAKE":          "institutional",
    "ARBI_CROSS_EXCHANGE": "arb",
    "REVERSION_A":         "mean_reversion",
    "SPREAD_FADE":         "mean_reversion",
    "VOLATILITY_BREAKOUT": "breakout",
}

_DISCOVER_SYSTEM_PROMPT = """
You are a quantitative pattern analyst for EchoForge. Analyze recent fill history to discover profitable conditions.

Feature index: 0=momentum, 1=z_score, 2=vwap_dev, 3=imbalance, 4=vol_ratio, 5=spread_norm,
               6=ema_fast_dev, 7=ema_slow_dev, 8=cost_basis_dev, 9=unrealized_norm,
               10=position_size_norm, 11=sentiment_score, 12=sentiment_momentum
Fill format: f=[up to 13 features], o=outcome(1=win/0=loss), pnl=realized_pnl, r=regime, p=pattern_id, pu=ML_confidence(0-1)

Available patterns and their types:
- MOMENTUM_V1 (momentum): directional flow
- DEPTH_GRAB (maker): resting-order sweep — bad in high VPIN
- SUPERTREND_CROSS (trend): long-memory trend following
- WHALE_WAKE (institutional): TWAP/VWAP piggybacking
- ARBI_CROSS_EXCHANGE (arb): cross-exchange timing edge
- REVERSION_A (mean_reversion): VWAP/EMA snap-back
- SPREAD_FADE (mean_reversion): spread compression
- VOLATILITY_BREAKOUT (breakout): z_score expansion + VPIN confirmation

Find up to 3 discoveries:
1. Which regime+pattern combinations have the highest win rate
2. Feature thresholds that correlate with wins (e.g. "z_score>1.2 → 80% win rate")
3. Any emerging profitable condition or pattern type that is over/under-performing

Name each discovery concisely (e.g. "ZScore_Reversion", "LowVol_MomBurst", "HighImbal_Buy").

RESPOND WITH ONLY this JSON (no markdown):
{"discoveries":[{"pattern_label":"NAME","insight_type":"regime_synergy|feature_threshold|emerging",
"observation":"one factual sentence with specific numbers","confidence":0.0,"win_rate":0.0,
"sample_count":0,"suggested_phic":{}}]}

Rules for suggested_phic: only include when sample_count>=5 and win_rate>0.6.
suggested_phic keys: autonomy_level(float), preferred_patterns(list), vetoed_patterns(list), regime_caps(dict).
"""


def _clamp_plan(raw: dict) -> dict:
    raw["autonomy_level"]   = max(0.1, min(1.0, float(raw.get("autonomy_level",   0.5))))
    raw["max_position_pct"] = max(1,   min(100, int(raw.get("max_position_pct", 20))))
    horizon = int(raw.get("time_horizon_ms", 300_000))
    while horizon > 3_600_000 and horizon % 10 == 0:
        horizon //= 10
    raw["time_horizon_ms"] = max(30_000, min(3_600_000, horizon))
    target = float(raw.get("target_pnl_pct", 5.0))
    stop   = float(raw.get("stop_loss_pct",  target * 0.3))
    if stop >= target:
        stop = target * 0.3
    raw["stop_loss_pct"]      = round(max(0.1, stop), 2)
    preferred = set(raw.get("preferred_patterns") or []) & _ALL_PATTERNS
    if not preferred:
        preferred = {"MOMENTUM_V1"}
    raw["preferred_patterns"] = list(preferred)
    raw["vetoed_patterns"]    = list(_ALL_PATTERNS - preferred)
    caps = dict(raw.get("regime_caps") or {})
    caps = {k: v for k, v in caps.items() if k in ("HighVol", "LowVol") and float(v) > 0}
    caps["Crisis"] = 0
    raw["regime_caps"] = caps
    return raw


def _ollama_chat(ollama_url: str, model: str, system: str, user: str) -> dict | None:
    import requests as _req, json as _json
    try:
        resp = _req.post(
            ollama_url.rstrip("/") + "/api/chat",
            json={
                "model":    model,
                "messages": [{"role": "system", "content": system},
                              {"role": "user",   "content": user}],
                "stream":   False,
                "format":   "json",
            },
            timeout=30,
        )
        resp.raise_for_status()
        return _json.loads(resp.json()["message"]["content"])
    except Exception as exc:
        logger.warning("Ollama call failed: %s", exc)
        return None


def _call_ollama_discover(fills: list, current_phic: dict, ollama_url: str, model: str) -> list:
    import json as _json
    compact = []
    for f in fills[-50:]:
        feat = f.get("features") or []
        compact.append({
            "f":   [round(float(v), 4) for v in list(feat)[:8]],
            "o":   int(f.get("outcome", 0)),
            "pnl": round(float(f.get("pnl", 0)), 4),
            "r":   str(f.get("regime_tag", "?")),
            "p":   str(f.get("pattern_id", "?")),
            "pu":  round(float(f.get("p_up", 0.5)), 3),
        })
    payload = _json.dumps({"fills": compact, "phic": {
        "autonomy_level":  current_phic.get("autonomy_level", 0.5),
        "vetoed_patterns": current_phic.get("vetoed_patterns", []),
    }})
    raw = _ollama_chat(ollama_url, model, _DISCOVER_SYSTEM_PROMPT, payload)
    if not isinstance(raw, dict):
        return []
    discoveries = raw.get("discoveries") or []
    if not isinstance(discoveries, list):
        return []
    result = []
    for item in discoveries[:3]:
        if not isinstance(item, dict):
            continue
        phic = item.get("suggested_phic") or {}
        if isinstance(phic, dict) and phic:
            try:
                sanitized = _clamp_plan({"target_pnl_pct": 5.0, "time_horizon_ms": 300_000,
                                         "stop_loss_pct": 2.0, **phic})
                phic = {k: sanitized[k] for k in ("autonomy_level", "max_position_pct",
                        "preferred_patterns", "vetoed_patterns", "regime_caps") if k in sanitized}
            except Exception:
                phic = {}
        result.append({
            "pattern_label": str(item.get("pattern_label", "UNKNOWN"))[:24],
            "insight_type":  str(item.get("insight_type",  "general"))[:30],
            "observation":   str(item.get("observation",   ""))[:200],
            "confidence":    max(0.0, min(1.0, float(item.get("confidence",   0.5)))),
            "win_rate":      max(0.0, min(1.0, float(item.get("win_rate",     0.5)))),
            "sample_count":  int(item.get("sample_count", 0)),
            "suggested_phic": phic,
        })
    logger.info("Discovery: %d insights from %d fills", len(result), len(compact))
    return result


@router.post("/adapt/analyze-toxic-state")
async def analyze_toxic_state(snapshot: dict):
    """
    Analyse a killswitch event snapshot (toxic state) to identify patterns that preceded
    the drawdown / floor breach. Uses the Ollama discover pipeline if available.

    Returns phic_suggestions and a brief risk_summary.
    """
    trigger     = snapshot.get("trigger", "unknown")
    regime      = snapshot.get("regime", "?")
    echoes      = snapshot.get("echoes", [])
    log15m      = snapshot.get("signal_log_15m", [])
    portfolio   = snapshot.get("portfolio", {})
    ghost_trades = snapshot.get("ghost_trades", [])  # Guardian shadow NACKs

    # Convert signal log to discovery-compatible fill records
    fills = []
    for entry in log15m[-50:]:
        fills.append({
            "pattern_id": entry.get("pattern_id", "?"),
            "regime_tag": entry.get("regime_tag", regime),
            "pnl":        float(entry.get("net_alpha", 0)),
            "outcome":    1 if float(entry.get("outcome_score", 0)) > 0 else 0,
            "p_up":       0.5 + float(entry.get("net_alpha", 0)) / 2,
            "features":   [],
        })

    # Detect high-aliveness patterns present before freeze
    active_patterns = [e["pattern_id"] for e in echoes if float(e.get("net_aliveness", 0)) > 0.3]

    # Fast heuristic suggestions (no LLM required)
    suggestions = []
    vpin_vals   = [float(e.get("vpin", 0)) for e in log15m if "vpin" in e]
    avg_vpin    = sum(vpin_vals) / len(vpin_vals) if vpin_vals else 0

    if avg_vpin > 0.5:
        suggestions.append({
            "type": "hurdle_increase",
            "pattern": "ALL",
            "reason": f"High avg VPIN ({avg_vpin:.2f}) in 15m window before {trigger}",
            "suggested_change": {"vpin_highvol_threshold": round(avg_vpin * 0.9, 2)},
        })
    if trigger == "floor_breach":
        tv  = float(portfolio.get("total_value", 0))
        hwm = float(snapshot.get("hwm", tv))
        dd  = (hwm - tv) / hwm if hwm > 0 else 0
        suggestions.append({
            "type": "exposure_reduction",
            "pattern": "ALL",
            "reason": f"Floor breach with {dd*100:.1f}% drawdown — tighten max exposure",
            "suggested_change": {
                "max_total_exposure_pct": round(max(0.05, (1 - dd) * 0.15), 3),
            },
        })

    risk_summary = (
        f"{trigger.upper()} in {regime} regime. "
        f"Active patterns: {', '.join(active_patterns[:5]) or 'none'}. "
        f"VPIN avg: {avg_vpin:.2f}. "
        f"Signals captured: {len(log15m)}."
    )

    # Optionally enrich with Ollama if fills are available
    import os
    ollama_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
    if fills:
        loop = asyncio.get_event_loop()
        try:
            discoveries = await loop.run_in_executor(
                None, _call_ollama_discover, fills,
                {"autonomy_level": 0.5, "vetoed_patterns": []},
                ollama_url, "gemma4:e2b"
            )
            for d in discoveries[:3]:
                if d.get("suggested_phic"):
                    suggestions.append({
                        "type":   "llm_discovery",
                        "pattern": d.get("pattern_label", "?"),
                        "reason": d.get("observation", "")[:150],
                        "suggested_change": d["suggested_phic"],
                    })
        except Exception as exc:
            logger.debug("Ollama analysis skipped: %s", exc)

    # Ghost trade regret analysis — how much did Guardian NACKs cost / save?
    regret_summary = None
    if ghost_trades:
        total_regret = sum(float(g.get("regret_pnl", 0)) for g in ghost_trades if g.get("regret_pnl") is not None)
        resolved     = [g for g in ghost_trades if g.get("regret_pnl") is not None]
        saved        = sum(float(g["regret_pnl"]) for g in resolved if float(g["regret_pnl"]) < 0)
        missed       = sum(float(g["regret_pnl"]) for g in resolved if float(g["regret_pnl"]) > 0)
        regret_summary = {
            "ghost_count":       len(ghost_trades),
            "resolved_count":    len(resolved),
            "total_regret_usd":  round(total_regret, 2),
            "saved_usd":         round(abs(saved), 2),    # losses avoided
            "missed_profit_usd": round(missed, 2),        # gains blocked
            "net_guardian_value": round(abs(saved) - missed, 2),
        }
        # Suggest loosening conflict window if Guardian missed more than it saved
        if missed > abs(saved) * 1.5 and len(resolved) >= 5:
            suggestions.append({
                "type": "guardian_tune",
                "pattern": "ALL",
                "reason": f"Guardian regret analysis: missed ${missed:.2f} vs saved ${abs(saved):.2f} — conflict window may be too tight",
                "suggested_change": {"conflict_window_ms": 3000},
            })

    _cache_suggestions(suggestions)
    logger.info("Toxic state analysis: trigger=%s regime=%s patterns=%d suggestions=%d ghosts=%d",
                trigger, regime, len(active_patterns), len(suggestions), len(ghost_trades))
    return JSONResponse({
        "phic_suggestions":  suggestions,
        "risk_summary":      risk_summary,
        "active_patterns":   active_patterns,
        "regret_summary":    regret_summary,
    })


@router.post("/adapt/push-suggestions")
async def push_suggestions():
    """
    Replay the latest cached PHIC suggestions to all connected dashboard/browser consumers.
    Called by the browser auto-adapt cycle or external tooling to surface pending suggestions.
    """
    from .metrics import broadcast_event

    suggestions = _latest_suggestions
    if not suggestions:
        return JSONResponse({"pushed": 0, "suggestions": []})

    await broadcast_event({"type": "phic_suggestions", "suggestions": suggestions,
                            "timestamp": int(asyncio.get_event_loop().time() * 1000)})
    logger.info("Pushed %d PHIC suggestions to WS subscribers", len(suggestions))
    return JSONResponse({"pushed": len(suggestions), "suggestions": suggestions})


@router.post("/adapt/train-ofi")
async def train_ofi(req: TrainOfiRequest) -> Response:
    """
    Train a lightweight OFI (Order Flow Imbalance) classifier on L2 delta sequences.

    Accepts labelled snapshots: 12-feature vectors (delta_bid_L1..L5, delta_ask_L1..L5,
    vpin, spread_norm) paired with binary outcomes (1=price up, 0=down within forward_ms).
    Returns ONNX bytes for hot-swap via `reload_ofi_model` IPC message.
    """
    import io
    import numpy as np

    X = np.array(req.l2_sequences, dtype=np.float32)
    y = np.array(req.outcomes,     dtype=np.int32)

    if len(X) < 30:
        return JSONResponse({"error": "Need at least 30 labelled sequences"}, status_code=400)
    if X.shape[1] != req.n_features:
        return JSONResponse(
            {"error": f"Expected {req.n_features} features, got {X.shape[1]}"},
            status_code=400,
        )

    onnx_bytes = await asyncio.get_event_loop().run_in_executor(None, _train_ofi_model, X, y)
    pos_rate   = float(y.mean())
    logger.info("OFI model trained: %d samples  pos_rate=%.3f  features=%d",
                len(X), pos_rate, req.n_features)
    return Response(
        content=onnx_bytes,
        media_type="application/octet-stream",
        headers={
            "X-OFI-Samples":  str(len(X)),
            "X-OFI-PosRate":  f"{pos_rate:.3f}",
        },
    )


def _train_ofi_model(X: "np.ndarray", y: "np.ndarray") -> bytes:
    """Train MLPClassifier on OFI features and return ONNX bytes."""
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing  import StandardScaler
    from sklearn.pipeline       import Pipeline
    import skl2onnx
    from skl2onnx.common.data_types import FloatTensorType

    n_features = X.shape[1]
    pipeline = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp",    MLPClassifier(
            hidden_layer_sizes=(32, 16),
            activation="relu",
            max_iter=200,
            random_state=42,
            early_stopping=True,
            validation_fraction=0.15,
        )),
    ])
    pipeline.fit(X, y)

    initial_type = [("float_input", FloatTensorType([None, n_features]))]
    onx = skl2onnx.convert_sklearn(
        pipeline, initial_types=initial_type,
        options={"zipmap": False},
    )
    return onx.SerializeToString()


# ── Per-echo replay simulation ────────────────────────────────────────────


def _run_replay_tune(req: ReplayTuneRequest) -> dict:
    """
    Replay a session with different PHIC parameters and score each combination.

    Mirrors the fixed echoforge_worker.js aliveness logic exactly:
    - Separate aliveness per (pattern_id, regime_tag) echo
    - Gate check BEFORE signal_boost (the self-certification fix)
    - FIFO outcome matching per echo key (same as _pendingSignals in JS)
    - decay_rate floor at 0.06 (same clamp added to phic_update handler)
    """
    import math as _math
    from collections import defaultdict, deque
    from itertools import product as _product

    MIN_ALIVENESS   = 0.30   # seed / resurrection floor — not the execution gate
    DECAY_BY_TYPE   = {      # mirrors JS DECAY_BY_TYPE
        "mean_reversion": 0.08, "momentum": 0.12, "maker": 0.10,
        "trend": 0.06, "institutional": 0.08, "breakout": 0.20, "arb": 0.02,
    }
    STRATEGY_TYPE   = {      # mirrors JS _STRATEGY_TYPE
        "MOMENTUM_V1": "momentum", "VOLATILITY_BREAKOUT": "breakout",
        "REVERSION_A": "mean_reversion", "SPREAD_FADE": "mean_reversion",
        "DEPTH_GRAB": "maker", "WHALE_WAKE": "institutional",
        "ARBI_CROSS_EXCHANGE": "arb",
    }

    decisions = req.session.get("decisions", [])
    outcomes  = req.session.get("outcomes",  [])

    if not decisions:
        return {"error": "no decisions in session", "best": None, "top": []}

    # Build per-echo FIFO outcome queues keyed by (pattern_id, regime_tag)
    # Decisions and outcomes are matched in chronological order, same as JS.
    def _build_fifos():
        queues: dict = defaultdict(deque)
        for o in outcomes:
            pid     = o.get("pattern_id", "")
            regime  = o.get("regime_tag", "LowVol")
            score   = o.get("outcome_score")
            if pid and score is not None:
                queues[(pid, regime)].append(float(score))
        return queues

    def _simulate(decay_rate, loss_mult, min_consensus, signal_boost):
        fifo = _build_fifos()

        # Per-echo state: aliveness starts at MIN_ALIVENESS (seed value, same as JS)
        echo_alive: dict = defaultdict(lambda: MIN_ALIVENESS)
        scores, passed, dropped = [], 0, 0

        for d in decisions:
            if d.get("result") != "pass":
                continue
            pid    = d.get("pattern_id", "")
            regime = d.get("regime_tag",  "LowVol")
            key    = (pid, regime)

            # Gate check BEFORE boost — the core fix
            if echo_alive[key] < min_consensus:
                dropped += 1
                continue

            # Passed gate — apply boost
            echo_alive[key] = min(1.0, echo_alive[key] + signal_boost)
            passed += 1

            # Consume the next outcome for this echo (chronological FIFO match)
            if fifo[key]:
                score = fifo[key].popleft()
                scores.append(score)
                normalised = (score + 1.0) / 2.0
                stype      = STRATEGY_TYPE.get(pid, "momentum")
                base_decay = max(0.06, decay_rate)   # honour the floor
                alpha      = min(base_decay * loss_mult, 1.0) if score < 0 else base_decay
                echo_alive[key] = max(0.0, min(1.0,
                    echo_alive[key] * (1.0 - alpha) + normalised * alpha
                ))

        # Metrics
        if not scores:
            return None
        n         = len(scores)
        win_rate  = sum(1 for s in scores if s > 0) / n
        mean      = sum(scores) / n
        var       = sum((s - mean) ** 2 for s in scores) / n
        sharpe    = mean / _math.sqrt(var) if var > 0 else 0.0

        # Survival: fraction of echoes that ended above MIN_ALIVENESS
        alive_count   = sum(1 for v in echo_alive.values() if v >= MIN_ALIVENESS)
        total_echoes  = len(echo_alive) or 1
        echo_survival = alive_count / total_echoes

        return {
            "decay_rate":       round(decay_rate, 6),
            "loss_multiplier":  round(loss_mult, 4),
            "min_consensus":    round(min_consensus, 4),
            "signal_boost":     round(signal_boost, 4),
            "sharpe":           round(sharpe, 6),
            "win_rate":         round(win_rate, 6),
            "executions":       n,
            "pass_rate":        round(passed / (passed + dropped) if passed + dropped else 0, 4),
            "echo_survival":    round(echo_survival, 4),
        }

    def _linspace(lo, hi, n):
        n = int(n)
        if n == 1:
            return [lo]
        return [round(lo + (hi - lo) / (n - 1) * i, 6) for i in range(n)]

    dr_vals  = _linspace(*req.decay_range)
    lm_vals  = _linspace(*req.loss_range)
    mc_vals  = _linspace(*req.consensus_range)
    sb_vals  = _linspace(*req.signal_boost_range)

    all_params  = list(_product(dr_vals, lm_vals, mc_vals, sb_vals))
    all_results = [r for r in (_simulate(*p) for p in all_params) if r is not None]

    viable = [r for r in all_results
              if r["echo_survival"] >= req.survival_floor and r["executions"] >= 5]
    if not viable:
        viable = [r for r in all_results if r["executions"] >= 5] or all_results

    viable.sort(key=lambda r: r["sharpe"], reverse=True)
    best = viable[0] if viable else None

    if best:
        logger.info(
            "Replay tune: best decay=%.4f loss=%.2f consensus=%.2f boost=%.3f "
            "sharpe=%.4f wr=%.1f%% n=%d",
            best["decay_rate"], best["loss_multiplier"], best["min_consensus"],
            best["signal_boost"], best["sharpe"], best["win_rate"] * 100, best["executions"],
        )

    return {
        "best":       best,
        "top":        viable[:req.top_n],
        "grid_cells": len(all_params),
        "decisions":  len(decisions),
        "outcomes":   len(outcomes),
        "session_id": req.session.get("session_id", ""),
    }
