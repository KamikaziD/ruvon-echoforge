"""Metrics WebSocket — 100ms non-blocking push to PHIC dashboard."""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)
router = APIRouter(tags=["metrics"])

# All connected dashboard consumers
_dashboard_sockets: set[WebSocket] = set()

# Latest node metrics (keyed by node_id)
_node_metrics: dict[str, dict] = {}

# Latest macro state — updated by main.py _macro_task; null until first broadcast
_latest_macro_state: dict | None = None


def set_latest_macro_state(state: dict) -> None:
    global _latest_macro_state
    _latest_macro_state = state


def merge_browser_macro_state(browser_fields: dict) -> dict:
    """
    Merge browser-computed macro fields (depth, cvd_raw, etc.) into the existing
    bridge macro state without overwriting bridge-computed fields (persistence,
    cvd_div, correlation, hurst).  Returns the merged state.
    """
    global _latest_macro_state
    BROWSER_ONLY = {"depth", "cvd_raw", "depth_raw", "depth_ma", "last_vpin"}
    patch = {k: v for k, v in browser_fields.items() if k in BROWSER_ONLY}
    base = _latest_macro_state.copy() if _latest_macro_state else {"type": "macro_state"}
    merged = {**base, **patch, "timestamp": browser_fields.get("timestamp", base.get("timestamp", 0))}
    _latest_macro_state = merged
    return merged


async def broadcast_event(event: dict) -> None:
    """Forward any typed event (sentinel_alert, echo_snapshot, order_* …) to dashboard."""
    payload = json.dumps(event)
    dead: set[WebSocket] = set()
    for ws in frozenset(_dashboard_sockets):  # snapshot to avoid mutation during iteration
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _dashboard_sockets.difference_update(dead)


def record_node_metrics(node_id: str, metrics: dict) -> None:
    """Called by tick/execution workers to update node telemetry."""
    _node_metrics[node_id] = {**metrics, "node_id": node_id, "updated_at": int(time.time() * 1000)}


async def metrics_broadcaster():
    """Background task: pushes aggregated metrics to dashboard every 100ms."""
    while True:
        await asyncio.sleep(0.1)
        if not _dashboard_sockets or not _node_metrics:
            continue
        snapshot: dict = {
            "type": "metrics_snapshot",
            "nodes": list(_node_metrics.values()),
            "timestamp": int(time.time() * 1000),
        }
        if _latest_macro_state is not None:
            snapshot["macro_state"] = _latest_macro_state
        payload = json.dumps(snapshot)
        dead: set[WebSocket] = set()
        for ws in _dashboard_sockets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.add(ws)
        _dashboard_sockets.difference_update(dead)


@router.websocket("/metrics")
async def metrics_stream(ws: WebSocket):
    """
    Dashboard connects here to receive live node telemetry at 100ms cadence.

    Also accepts inbound node telemetry pushes:
        {"type": "node_metrics", "node_id": "...", "tick_latency_p99_ms": 12.3, ...}
    """
    await ws.accept()
    _dashboard_sockets.add(ws)
    logger.info("Metrics WebSocket connected (%d total)", len(_dashboard_sockets))

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "node_metrics":
                node_id = msg.get("node_id", "unknown")
                record_node_metrics(node_id, msg)
            elif msg.get("type") == "outcome_recorded":
                # Browser forwards execution results over WS — feed drift monitor
                from . import main as _bridge_main  # late import to avoid circular
                payload = msg.get("payload", msg)
                if isinstance(payload, dict) and payload.get("pattern_id"):
                    try:
                        _bridge_main._drift_queue.put_nowait(payload)
                    except Exception:
                        pass

    except WebSocketDisconnect:
        _dashboard_sockets.discard(ws)
        logger.info("Metrics WebSocket disconnected (%d remaining)", len(_dashboard_sockets))
    except Exception as exc:
        logger.exception("Metrics WebSocket error: %s", exc)
        _dashboard_sockets.discard(ws)
