"""FastAPI bridge — tick ingestion, PHIC config, metrics WebSocket."""

import asyncio
import collections
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .tick import router as tick_router, set_macro_analyzer
from .phic import router as phic_router, phic_state
from .metrics import router as metrics_router, metrics_broadcaster, broadcast_event, set_latest_macro_state
from .adapt import router as adapt_router
from .regime import RegimeDetector
from .ipc_client import DaemonIPCClient
from .drift_monitor import DriftMonitor
from .regression_optimizer import RegressionOptimizer, UPDATE_INTERVAL_S
from .macro_analyzer import MacroAnalyzer

logger = logging.getLogger(__name__)

# Rolling in-process outcome buffer — human-readable audit log.
# Capped at 2000 records; future modules import this directly.
outcome_buffer: collections.deque[dict[str, Any]] = collections.deque(maxlen=2000)

# Dedicated queue for DriftMonitor — /session/record enqueues here too.
# maxsize=5000 sheds load gracefully if the monitor falls behind.
_drift_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=5000)

# Module-level singletons — accessible to other bridge modules if needed
regime_detector:       RegimeDetector       | None = None
ipc_client:            DaemonIPCClient      | None = None
drift_monitor:         DriftMonitor         | None = None
regression_optimizer:  RegressionOptimizer  | None = None
macro_analyzer:        MacroAnalyzer        | None = None


async def _drift_checker(monitor: DriftMonitor) -> None:
    """
    Background task: drains _drift_queue into DriftMonitor every second,
    runs regression check every 30 s, and broadcasts alerts to the dashboard.
    """
    last_check      = time.monotonic()
    last_outcome_ts: float | None = None  # wall time of last decisive outcome received
    outcome_silence_alerted = False       # deduplicate alert per silence window

    while True:
        # Drain all queued outcomes into the monitor
        while not _drift_queue.empty():
            try:
                rec = _drift_queue.get_nowait()
                pid   = rec.get("pattern_id")
                score = rec.get("outcome_score")
                ts    = rec.get("timestamp")
                if pid is not None and score is not None:
                    monitor.add_outcome(pid, float(score), int(ts) if ts else None)
                    last_outcome_ts = time.monotonic()
                    outcome_silence_alerted = False
            except asyncio.QueueEmpty:
                break

        # Run regression every 30 s
        now = time.monotonic()
        if now - last_check >= 30.0:
            last_check = now
            alerts = monitor.check_drift()
            for alert in alerts:
                logger.info(
                    "Drift alert: %s slope=%.6f R²=%.2f zero_in=%.0fmin",
                    alert.pattern_id, alert.slope, alert.r2, alert.time_to_zero_min,
                )
                await broadcast_event({"type": "drift_alert", "payload": alert.to_dict()})

            # Outcome silence alert: if outcomes were submitted but none decisive for >1h
            if (last_outcome_ts is not None
                    and now - last_outcome_ts > 3600.0
                    and not outcome_silence_alerted):
                outcome_silence_alerted = True
                logger.warning("outcome_silence_alert: no decisive outcome recorded for >1h")
                await broadcast_event({
                    "type": "outcome_silence_alert",
                    "detail": "No decisive outcomes received by bridge for >1h — check fill pipeline",
                    "silence_seconds": int(now - last_outcome_ts),
                })

        await asyncio.sleep(1.0)


_STRATEGY_TYPES = [
    "momentum", "mean_reversion", "maker", "trend", "institutional", "breakout", "arb",
]


async def _regression_task(optimizer: RegressionOptimizer) -> None:
    """
    Background task: feeds outcomes to the regression optimizer, retrains every
    UPDATE_INTERVAL_S, and pushes improved per-type decay rates via PHIC when R² qualifies.
    Auto-reverts if post-push Sharpe degrades.
    """
    from .phic import phic_state
    import math

    last_retrain    = time.monotonic()
    processed_count = 0  # outcomes processed so far from outcome_buffer

    while True:
        await asyncio.sleep(5.0)

        # Feed newly buffered outcomes into the optimizer
        current_len = len(outcome_buffer)
        if current_len > processed_count:
            new_items = list(outcome_buffer)[processed_count:current_len]
            for rec in new_items:
                st    = rec.get("strategy_type") or "momentum"
                vpin  = float(rec.get("vpin") or 0.0)
                regime = rec.get("regime_tag") or "LowVol"
                score  = rec.get("outcome_score")
                if score is not None:
                    optimizer.add_observation(st, vpin, regime, float(score))
            processed_count = current_len

        # Retrain every UPDATE_INTERVAL_S
        now = time.monotonic()
        if now - last_retrain < UPDATE_INTERVAL_S:
            continue
        last_retrain = now

        # Check revert first — did any previous push degrade Sharpe?
        current_cfg = phic_state.config.model_dump()
        revert_fields: dict[str, Any] = {}
        for st in _STRATEGY_TYPES:
            if optimizer.check_revert(st):
                revert_fields[f"decay_rate_{st}"] = None
        if revert_fields:
            revert_fields["regression_override"] = True
            reverted = phic_state.config.model_copy(update=revert_fields)
            phic_state.update(reverted)
            await phic_state.broadcast(reverted, "revert")
            await broadcast_event({"type": "regression_applied", "config": revert_fields, "reverted": True})
            logger.warning("Regression optimizer: reverted %s", list(revert_fields.keys()))

        # Retrain all strategy types and push improvements
        push_fields: dict[str, Any] = {}
        for st in _STRATEGY_TYPES:
            improved = optimizer.retrain(st)
            if not improved:
                continue
            # Use representative current state: mean vpin from recent outcomes
            recent = [r for r in list(outcome_buffer)[-200:] if r.get("strategy_type") == st]
            if not recent:
                continue
            mean_vpin   = sum(float(r.get("vpin") or 0.0) for r in recent) / len(recent)
            mean_regime = "LowVol"  # default; could be modal but stable enough
            recommendation = optimizer.predict(st, mean_vpin, mean_regime)
            if recommendation is None:
                continue
            push_fields[f"decay_rate_{st}"] = round(recommendation, 5)
            # Record Sharpe-before for safety-net
            scores = [float(r["outcome_score"]) for r in recent if r.get("outcome_score") is not None]
            if len(scores) >= 10:
                mean_s = sum(scores) / len(scores)
                var_s  = sum((s - mean_s) ** 2 for s in scores) / len(scores)
                std_s  = math.sqrt(var_s) if var_s > 0 else 1e-9
                optimizer.record_push(st, sharpe_at_push=mean_s / std_s)

        if push_fields:
            push_fields["regression_last_applied_ms"] = int(time.time() * 1000)
            push_fields["regression_override"] = False
            updated = phic_state.config.model_copy(update=push_fields)
            phic_state.update(updated)
            await phic_state.broadcast(updated, "regression")
            await broadcast_event({"type": "regression_applied", "config": push_fields, "reverted": False})
            logger.info("Regression optimizer pushed: %s", push_fields)

        # Broadcast insights to dashboard regardless of whether a push happened
        await broadcast_event({
            "type":     "regression_insights",
            "insights": optimizer.get_insights(),
        })


MACRO_INTERVAL_S = 60.0  # broadcast macro_state every 60s


async def _macro_task(analyzer: MacroAnalyzer) -> None:
    """
    Background task: compute and broadcast macro_state every 60s.
    Safe to run in the asyncio event loop — compute_macro_state() is pure NumPy, <10ms.
    """
    # Short initial delay for startup stabilisation.  If warm-start K-lines were loaded the
    # ring buffer is already populated, so Hurst can compute within the first few seconds.
    await asyncio.sleep(10)
    while True:
        try:
            state = analyzer.compute_macro_state()
            set_latest_macro_state(state)
            await broadcast_event(state)
            # Relay via IPC so the daemon can forward to browser workers and dashboard.
            # broadcast_event() only reaches direct FastAPI /metrics subscribers;
            # the daemon (port 8765) is what browser tabs and the dashboard actually use.
            if ipc_client:
                await ipc_client.send(state)
            logger.debug(
                "macro_state: persistence=%s cvd_div=%s correlation=%s hurst=%s buf_n=%d",
                state["persistence"], state["cvd_div"], state["correlation"],
                state["hurst"], state.get("hurst_buf_n", 0),
            )
        except Exception as exc:
            logger.exception("macro_task error: %s", exc)
        await asyncio.sleep(MACRO_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global regime_detector, ipc_client, drift_monitor, regression_optimizer, macro_analyzer

    # Start background metrics broadcaster
    metrics_task = asyncio.create_task(metrics_broadcaster())

    # Start drift monitor background task
    drift_monitor  = DriftMonitor()
    drift_task     = asyncio.create_task(_drift_checker(drift_monitor))

    # Start regression optimizer background task
    regression_optimizer = RegressionOptimizer(
        model_dir=os.getenv("ECHOFORGE_MODEL_DIR", "models/")
    )
    regression_task = asyncio.create_task(_regression_task(regression_optimizer))

    # Start macro analyzer background task
    macro_analyzer = MacroAnalyzer()
    set_macro_analyzer(macro_analyzer)
    macro_task = asyncio.create_task(_macro_task(macro_analyzer))

    # Start HMM Navigator sidecar (IPC client + RegimeDetector)
    regime_detector = RegimeDetector()
    ipc_client      = DaemonIPCClient(regime_detector)
    await ipc_client.start()

    try:
        yield
    finally:
        metrics_task.cancel()
        drift_task.cancel()
        regression_task.cancel()
        macro_task.cancel()
        for t in (metrics_task, drift_task, regression_task, macro_task):
            try:
                await t
            except asyncio.CancelledError:
                pass
        if ipc_client:
            await ipc_client.stop()


def create_app() -> FastAPI:
    app = FastAPI(
        title="EchoForge Bridge",
        description="Tick ingestion, PHIC governance, and metrics WebSocket for the EchoForge Syndicate",
        version="0.1.1",
        lifespan=lifespan,
    )

    raw_origins = os.getenv("ECHOFORGE_CORS_ORIGINS", "*")
    # allow_origins=["*"] + allow_credentials=True is invalid per CORS spec —
    # browsers reject the combination. Use allow_origin_regex for wildcard with creds.
    if raw_origins.strip() == "*":
        app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=".*",
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    else:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=raw_origins.split(","),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(tick_router, prefix="/api/v1")
    app.include_router(phic_router, prefix="/api/v1")
    app.include_router(metrics_router, prefix="/api/v1")
    app.include_router(adapt_router, prefix="/api/v1")

    @app.post("/session/record")
    async def session_record(request: Request) -> JSONResponse:
        """Receive an outcome record from the daemon or browser and buffer it for learning modules."""
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)
        if not isinstance(payload, dict) or "pattern_id" not in payload:
            return JSONResponse({"ok": False, "error": "missing pattern_id"}, status_code=400)
        outcome_buffer.append(payload)
        try:
            _drift_queue.put_nowait(payload)
        except asyncio.QueueFull:
            pass  # shed under sustained load — drift monitor catches up on next drain
        return JSONResponse({"ok": True, "buffered": len(outcome_buffer)})

    return app


app = create_app()


def cli():
    """Entry point for `echoforge` CLI command."""
    import uvicorn

    host = os.getenv("ECHOFORGE_HOST", "0.0.0.0")
    port = int(os.getenv("ECHOFORGE_PORT", "8765"))
    uvicorn.run("ruvon_echoforge.bridge.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    cli()
