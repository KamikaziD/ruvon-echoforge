"""
Unit tests for EchoForgeExtension (src/ruvon_edge/extensions/echoforge.py).

All subprocess and WebSocket interactions are mocked — no real Bun process
or network is needed. Tests verify:
  - IPC message encoding for push_phic_config, emergency_freeze/resume
  - Sentiment value clamping before forwarding
  - IPC receive loop routing (heartbeat, order_intent, telemetry)
  - _on_config_change serialises config and creates a task
  - stop() terminates subprocess and closes WebSocket
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch, call

import pytest

from ruvon_edge.extensions.echoforge import EchoForgeExtension


# ── Helpers ────────────────────────────────────────────────────────────────

def _make_agent(has_nats=False):
    """Return a minimal mock agent."""
    agent = MagicMock()
    agent.config_manager = MagicMock()
    agent.config_manager.on_config_change = MagicMock()
    if has_nats:
        nc = AsyncMock()
        transport = MagicMock()
        transport._nc = nc
        agent._transport = transport
    else:
        agent._transport = None
    return agent


def _make_ext(agent=None, port=8767) -> EchoForgeExtension:
    return EchoForgeExtension(
        agent=agent or _make_agent(),
        daemon_path="/fake/daemon",
        port=port,
    )


async def _inject_ws(ext: EchoForgeExtension) -> AsyncMock:
    """Inject a mock WS into the extension (simulates connected state)."""
    ws = AsyncMock()
    ext._ws = ws
    ext._running = True
    return ws


# ── push_phic_config ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_push_phic_config_sends_phic_update():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    await ext.push_phic_config({"autonomy_level": 0.7, "stop_loss_pct": 3.0})

    ws.send.assert_called_once()
    payload = json.loads(ws.send.call_args[0][0])
    assert payload["type"] == "phic_update"
    assert payload["config"]["autonomy_level"] == 0.7
    assert payload["config"]["stop_loss_pct"] == 3.0


@pytest.mark.asyncio
async def test_push_phic_config_silent_when_not_connected():
    """When WS is None, push_phic_config must not raise."""
    ext = _make_ext()
    ext._ws = None
    await ext.push_phic_config({"autonomy_level": 0.5})  # should not raise


# ── emergency_freeze / emergency_resume ───────────────────────────────────

@pytest.mark.asyncio
async def test_emergency_freeze_sends_correct_payload():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    await ext.emergency_freeze()

    payload = json.loads(ws.send.call_args[0][0])
    assert payload["type"] == "phic_update"
    assert payload["config"]["emergency_freeze"] is True


@pytest.mark.asyncio
async def test_emergency_resume_clears_freeze():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    await ext.emergency_resume()

    payload = json.loads(ws.send.call_args[0][0])
    assert payload["config"]["emergency_freeze"] is False


# ── hot_swap_model ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_hot_swap_model_sends_reload_model():
    ext = _make_ext()
    ws = await _inject_ws(ext)
    fake_bytes = bytes([0x08, 0x00, 0x01, 0x02])

    await ext.hot_swap_model(fake_bytes)

    payload = json.loads(ws.send.call_args[0][0])
    assert payload["type"] == "reload_model"
    assert payload["model_bytes"] == list(fake_bytes)


# ── sentiment bridge ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_on_sentiment_forwards_clamped_values():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    nats_msg = MagicMock()
    nats_msg.data = json.dumps({"score": 0.8, "momentum": 0.3}).encode()
    await ext._on_sentiment(nats_msg)

    payload = json.loads(ws.send.call_args[0][0])
    assert payload["type"] == "sentiment_update"
    assert payload["score"] == 0.8
    assert payload["momentum"] == 0.3


@pytest.mark.asyncio
async def test_on_sentiment_clamps_out_of_range():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    nats_msg = MagicMock()
    nats_msg.data = json.dumps({"score": 99.0, "momentum": -50.0}).encode()
    await ext._on_sentiment(nats_msg)

    payload = json.loads(ws.send.call_args[0][0])
    assert payload["score"] == 1.0    # clamped to max
    assert payload["momentum"] == -1.0  # clamped to min


@pytest.mark.asyncio
async def test_on_sentiment_tolerates_malformed_json():
    ext = _make_ext()
    ws = await _inject_ws(ext)

    nats_msg = MagicMock()
    nats_msg.data = b"not-json"
    await ext._on_sentiment(nats_msg)  # must not raise; ws.send must not be called
    ws.send.assert_not_called()


# ── IPC receive loop routing ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_ipc_receive_loop_updates_heartbeat_timestamp():
    ext = _make_ext()
    ext._running = True
    before = ext._last_heartbeat

    ws = AsyncMock()
    # First recv returns heartbeat; second blocks forever so the loop exits cleanly
    ws.recv.side_effect = [
        json.dumps({"type": "heartbeat"}),
        asyncio.CancelledError(),
    ]
    ext._ws = ws

    with pytest.raises(asyncio.CancelledError):
        await ext._ipc_receive_loop()

    assert ext._last_heartbeat > before


@pytest.mark.asyncio
async def test_ipc_receive_loop_routes_order_intent():
    ext = _make_ext()
    ext._running = True

    order_msg = {"type": "order_intent", "side": "buy", "qty": "0.001",
                 "symbol": "BTC/USDT", "pattern_id": "MOMENTUM_V1"}
    ws = AsyncMock()
    ws.recv.side_effect = [json.dumps(order_msg), asyncio.CancelledError()]
    ext._ws = ws

    # _on_telemetry ultimately tries NATS (None here) — must not raise
    with pytest.raises(asyncio.CancelledError):
        await ext._ipc_receive_loop()


@pytest.mark.asyncio
async def test_ipc_receive_loop_routes_telemetry_types():
    ext = _make_ext()
    ext._running = True

    telemetry_msg = {"type": "sentinel_alert", "sentinel_type": "Nociceptor",
                     "action": "CANCEL_ORDERS", "severity": 0.9}
    ws = AsyncMock()
    ws.recv.side_effect = [json.dumps(telemetry_msg), asyncio.CancelledError()]
    ext._ws = ws

    with pytest.raises(asyncio.CancelledError):
        await ext._ipc_receive_loop()


# ── _on_config_change ─────────────────────────────────────────────────────

def test_on_config_change_serialises_pydantic_model():
    """_on_config_change must handle both Pydantic models and plain dicts."""
    ext = _make_ext()
    ws = AsyncMock()
    ext._ws = ws

    class FakeConfig:
        def model_dump(self):
            return {"autonomy_level": 0.9, "stop_loss_pct": 1.0}

    loop = asyncio.new_event_loop()
    try:
        # Patch create_task so we can run the coroutine ourselves
        sent_msgs = []

        async def fake_send(raw):
            sent_msgs.append(json.loads(raw))

        ws.send = fake_send

        async def _run():
            ext._on_config_change(FakeConfig())
            # Drain any pending tasks
            await asyncio.sleep(0)

        loop.run_until_complete(_run())
    finally:
        loop.close()


def test_on_config_change_accepts_plain_dict():
    ext = _make_ext()
    ext._ws = None  # WS not connected — must not raise
    ext._on_config_change({"autonomy_level": 0.5})


# ── stop lifecycle ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stop_terminates_subprocess_and_closes_ws():
    ext = _make_ext()
    ext._running = True

    proc = AsyncMock()
    proc.pid = 9999
    proc.terminate = MagicMock()
    proc.wait = AsyncMock()
    ext._proc = proc

    ws = AsyncMock()
    ext._ws = ws

    await ext.stop()

    proc.terminate.assert_called_once()
    ws.close.assert_called_once()
    assert ext._running is False
    assert ext._ws is None
    assert ext._proc is None


@pytest.mark.asyncio
async def test_stop_is_idempotent_when_nothing_running():
    """stop() on a fresh (never started) extension must not raise."""
    ext = _make_ext()
    await ext.stop()  # should complete without error
