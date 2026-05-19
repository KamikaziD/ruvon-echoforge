"""Tick ingestion — WebSocket endpoint that receives L2 ticks from the browser node."""

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..echoforge.engine import EchoForgeEngine
from .metrics import broadcast_event, set_latest_macro_state, merge_browser_macro_state
from .phic import phic_state, PHICConfig

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tick"])

# Shared engine instance (injected at startup or created lazily)
_engine: EchoForgeEngine | None = None

# MacroAnalyzer singleton — injected by main.py at startup
_macro_analyzer = None


def get_engine() -> EchoForgeEngine:
    global _engine
    if _engine is None:
        _engine = EchoForgeEngine()
    return _engine


def set_macro_analyzer(analyzer) -> None:
    """Called by main.py after creating the MacroAnalyzer singleton."""
    global _macro_analyzer
    _macro_analyzer = analyzer


@router.websocket("/tick")
async def tick_feed(ws: WebSocket):
    """
    WebSocket endpoint for market tick ingestion.

    Browser sends MarketTick JSON; bridge forwards to EchoForge engine and
    rebroadcasts sentinel decisions back to the node.

    Message format (browser → bridge):
        {"type": "tick", "symbol": "BTC/USDT", "bid": 42000.0, "ask": 42001.0,
         "buy_volume": 1.5, "sell_volume": 0.8, "timestamp": 1700000000000}

    Message format (bridge → browser):
        {"type": "sentinel", "action": "CANCEL_ORDERS", "severity": 0.9, ...}
        {"type": "echo_update", "pattern_id": "...", "net_aliveness": 0.7, ...}
    """
    await ws.accept()
    engine = get_engine()
    node_id = ws.headers.get("x-node-id", "unknown")
    logger.info("Tick WebSocket connected: node=%s", node_id)

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type")

            if msg_type == "tick":
                alerts = await engine.process_tick(msg)
                for alert in alerts:
                    alert_msg = {"type": "sentinel_alert", "node_id": node_id, **alert}
                    await ws.send_text(json.dumps({"type": "sentinel", **alert}))
                    await broadcast_event(alert_msg)
                # Feed macro analyzer (1s-rate-limited internally)
                if _macro_analyzer is not None:
                    price    = (float(msg.get("bid", 0)) + float(msg.get("ask", 0))) / 2
                    buy_vol  = float(msg.get("buy_volume",  0))
                    sell_vol = float(msg.get("sell_volume", 0))
                    if price > 0:
                        ts = float(msg.get("timestamp", 0)) / 1000 or None
                        _macro_analyzer.add_tick(price, buy_vol, sell_vol, ts)

            elif msg_type == "execution_result":
                pattern_id = msg.get("pattern_id")
                outcome = msg.get("outcome_score", 0.0)
                if pattern_id:
                    echo = await engine.record_outcome(pattern_id, outcome)
                    if echo:
                        await ws.send_text(json.dumps({"type": "echo_update", **echo}))

            elif msg_type == "correlation_signal":
                # BTC/ETH Pearson forwarded from correlation_worker via index.html.
                # Feeds the structural correlation dimension of the macro analyzer.
                if _macro_analyzer is not None:
                    pearson = msg.get("pearson")
                    if pearson is not None:
                        _macro_analyzer.add_correlation_sample(float(pearson))
                # Also relay to dashboard for display
                await broadcast_event({**msg, "node_id": node_id})

            elif msg_type == "macro_state":
                # Browser sends partial macro_state (depth, cvd_raw, depth_raw, depth_ma,
                # last_vpin).  Merge ONLY those browser-side fields into the bridge state;
                # never overwrite bridge-computed fields (persistence, cvd_div, correlation,
                # hurst) — those arrive via _macro_task every 60s.
                merged = merge_browser_macro_state(msg)
                await broadcast_event({**merged, "node_id": node_id})

            elif msg_type == "WARM_START_MACRO":
                # Browser sends 3-day 1m K-lines on startNode() to pre-warm macro buffers.
                # warm_start() is CPU-bound but completes in <100ms — safe to run in the
                # asyncio loop (no blocking I/O; pure NumPy array ops).
                if _macro_analyzer is not None:
                    btc_klines = msg.get("btc", [])
                    eth_klines = msg.get("eth", [])
                    _macro_analyzer.warm_start(btc_klines, eth_klines)
                    logger.info("WARM_START_MACRO processed: %d BTC klines", len(btc_klines))
                    await broadcast_event({"type": "macro_state_ready", "source": "bridge"})
                else:
                    logger.warning("WARM_START_MACRO received but MacroAnalyzer not initialised")

            elif msg_type in ("order_submitted", "order_failed", "saf_queued",
                              "sovereign_update", "echo_snapshot", "sentinel_alert",
                              "metrics_snapshot", "portfolio_update",
                              "stop_loss_notification", "cap_trim_notification"):
                # Browser node telemetry — relay to all connected dashboard WebSockets
                await broadcast_event({**msg, "node_id": node_id})

            elif msg_type == "phic_update":
                # Browser node pushed a config change (preset button, slider, or PHICClient.push).
                # Merge the patch into phic_state and broadcast to all other clients.
                patch = msg.get("config", {})
                if patch:
                    merged = phic_state.config.model_copy(update=patch)
                    config_hash = phic_state.update(merged)
                    await phic_state.broadcast(merged, config_hash)

            elif msg_type == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        logger.info("Tick WebSocket disconnected: node=%s", node_id)
    except Exception as exc:
        logger.exception("Tick WebSocket error: %s", exc)
        await ws.close(code=1011)
