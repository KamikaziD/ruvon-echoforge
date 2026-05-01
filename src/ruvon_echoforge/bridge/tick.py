"""Tick ingestion — WebSocket endpoint that receives L2 ticks from the browser node."""

import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..echoforge.engine import EchoForgeEngine
from .metrics import broadcast_event

logger = logging.getLogger(__name__)
router = APIRouter(tags=["tick"])

# Shared engine instance (injected at startup or created lazily)
_engine: EchoForgeEngine | None = None


def get_engine() -> EchoForgeEngine:
    global _engine
    if _engine is None:
        _engine = EchoForgeEngine()
    return _engine


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

            elif msg_type == "execution_result":
                pattern_id = msg.get("pattern_id")
                outcome = msg.get("outcome_score", 0.0)
                if pattern_id:
                    echo = await engine.record_outcome(pattern_id, outcome)
                    if echo:
                        await ws.send_text(json.dumps({"type": "echo_update", **echo}))

            elif msg_type in ("order_submitted", "order_failed", "saf_queued",
                              "sovereign_update", "echo_snapshot", "sentinel_alert",
                              "metrics_snapshot", "portfolio_update"):
                # Browser node telemetry — relay to all connected dashboard WebSockets
                await broadcast_event({**msg, "node_id": node_id})

            elif msg_type == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        logger.info("Tick WebSocket disconnected: node=%s", node_id)
    except Exception as exc:
        logger.exception("Tick WebSocket error: %s", exc)
        await ws.close(code=1011)
