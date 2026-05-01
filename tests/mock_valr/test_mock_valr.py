"""Tests for the mock VALR server and VALRAdapter integration."""

import asyncio
import pytest
import httpx
from fastapi.testclient import TestClient

from .server import app, _state, MockState


@pytest.fixture(autouse=True)
def reset_state():
    """Reset mock state between tests."""
    original = MockState()
    _state.base_price        = original.base_price
    _state.volatility        = original.volatility
    _state.toxic_mode        = False
    _state.rate_limit_active = False
    _state.latency_jitter_ms = 0
    _state.order_fill_mode   = "immediate"
    _state.open_orders.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


# ── Public endpoints ────────────────────────────────────────────────────────

def test_public_time(client):
    resp = client.get("/v1/public/time")
    assert resp.status_code == 200
    data = resp.json()
    assert "epochTime" in data
    assert data["epochTime"] > 0


def test_orderbook(client):
    resp = client.get("/v1/marketdata/BTCUSDT/orderbook")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["Bids"]) == 20
    assert len(data["Asks"]) == 20
    best_bid = float(data["Bids"][0]["price"])
    best_ask = float(data["Asks"][0]["price"])
    assert best_bid < best_ask, "Orderbook crossed"


# ── Order submission ────────────────────────────────────────────────────────

def test_market_order_immediate(client):
    resp = client.post("/v1/orders/market", json={
        "side": "BUY", "quantity": "0.001", "pair": "BTCUSDT",
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "FILLED"
    assert "id" in data


def test_limit_order(client):
    resp = client.post("/v1/orders/limit", json={
        "side": "SELL", "quantity": "0.001", "pair": "BTCUSDT", "price": "50000.00",
    })
    assert resp.status_code == 200
    assert resp.json()["status"] == "FILLED"


def test_order_rejection(client):
    client.post("/mock/order-fill", json={"mode": "reject", "reject_reason": "Insufficient balance"})
    resp = client.post("/v1/orders/market", json={"side": "BUY", "quantity": "99999"})
    assert resp.status_code == 400


def test_cancel_orders(client):
    # Place two orders first
    client.post("/v1/orders/market", json={"side": "BUY", "quantity": "0.001", "pair": "BTCUSDT"})
    client.post("/v1/orders/market", json={"side": "BUY", "quantity": "0.001", "pair": "BTCUSDT"})
    resp = client.delete("/v1/orders/BTCUSDT")
    assert resp.status_code == 200
    cancelled = resp.json()["cancelled"]
    assert len(cancelled) == 2


# ── Mock control API ────────────────────────────────────────────────────────

def test_rate_limit_injection(client):
    client.post("/mock/rate-limit", json={"active": True})
    resp = client.post("/v1/orders/market", json={"side": "BUY", "quantity": "0.001"})
    assert resp.status_code == 429
    assert "Retry-After" in resp.headers
    # Clear rate limit
    client.post("/mock/rate-limit", json={"active": False})
    resp2 = client.post("/v1/orders/market", json={"side": "BUY", "quantity": "0.001", "pair": "BTCUSDT"})
    assert resp2.status_code == 200


def test_toxicity_injection(client):
    client.post("/mock/toxicity", json={"duration_seconds": 5.0})
    state = client.get("/mock/state").json()
    assert state["toxic_mode"] is True
    client.post("/mock/toxicity/clear")
    state = client.get("/mock/state").json()
    assert state["toxic_mode"] is False


def test_price_override(client):
    client.post("/mock/price", json={"base_price": 100000.0, "volatility": 0.001})
    state = client.get("/mock/state").json()
    assert state["base_price"] == 100000.0
    # Orderbook should reflect new price
    resp = client.get("/v1/marketdata/BTCUSDT/orderbook")
    best_bid = float(resp.json()["Bids"][0]["price"])
    assert best_bid > 99_000  # close to 100k


def test_state_endpoint(client):
    state = client.get("/mock/state").json()
    assert "base_price" in state
    assert "ws_clients" in state
    assert "open_orders" in state


# ── EchoForge engine integration ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_engine_vpin():
    """Confirm the EchoForge engine detects toxicity from skewed ticks."""
    from ruvon_echoforge.echoforge.engine import EchoForgeEngine
    engine = EchoForgeEngine()

    # Inject 50 strongly buy-skewed ticks
    for _ in range(50):
        alerts = await engine.process_tick({
            "buy_volume":  1.0,
            "sell_volume": 0.05,
            "timestamp":   int(asyncio.get_event_loop().time() * 1000),
        })

    assert engine.current_vpin > 0.70, f"Expected VPIN > 0.70, got {engine.current_vpin:.3f}"
    # Last batch should have triggered a Nociceptor alert
    last_alerts = await engine.process_tick({"buy_volume": 1.0, "sell_volume": 0.05})
    assert any(a["sentinel_type"] == "Nociceptor" for a in last_alerts)


@pytest.mark.asyncio
async def test_bayesian_decay_win():
    from ruvon_echoforge.echoforge.decay import MarketEcho
    echo = MarketEcho(pattern_id="TEST_A", net_aliveness=0.5, decay_rate=0.1)
    # Positive outcome should increase aliveness
    echo.update(1.0)
    assert echo.net_aliveness > 0.5


@pytest.mark.asyncio
async def test_bayesian_decay_loss():
    from ruvon_echoforge.echoforge.decay import MarketEcho
    echo = MarketEcho(pattern_id="TEST_B", net_aliveness=0.5, decay_rate=0.1)
    # Loss should decay aliveness faster (×7 multiplier)
    echo.update(-1.0)
    assert echo.net_aliveness < 0.5


@pytest.mark.asyncio
async def test_saf_queue_enqueue_replay():
    from ruvon_echoforge.saf.queue import SAFQueue, SAFEntry
    q = SAFQueue(db_path=":memory:")
    await q.start()

    entry = SAFEntry(
        pattern_id="TEST_P", symbol="BTC/USDT", side="buy", quantity=0.001
    )
    entry_id = await q.enqueue(entry)
    assert await q.pending_count() == 1

    submitted = []
    async def fake_submit(e):
        submitted.append(e.entry_id)
        return True

    count = await q.replay(fake_submit)
    assert count == 1
    assert entry_id in submitted
    assert await q.pending_count() == 0

    await q.stop()
