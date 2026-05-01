"""
Mock VALR server — drop-in replacement for VALR REST + WebSocket API.

Serves synthetic L2 data, accepts orders, and exposes a /mock control API
so tests can inject toxicity events, rate-limit conditions, and latency jitter.

Usage:
    python -m ruvon_echoforge.tests.mock_valr.server          # default port 8766
    python -m ruvon_echoforge.tests.mock_valr.server --port 9000

Point the VALR adapter at it:
    adapter = VALRAdapter(
        api_key="test", api_secret="test",
        rest_base="http://localhost:8766",
        ws_base="ws://localhost:8766",
    )
"""

import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# ── Real VALR WebSocket credentials (optional — falls back to simulation) ──
# Set VALR_API_KEY + VALR_API_SECRET env vars to relay live VALR market data.
VALR_API_KEY    = os.getenv("VALR_API_KEY", "")
VALR_API_SECRET = os.getenv("VALR_API_SECRET", "")
VALR_WS_URL     = os.getenv("VALR_WS_URL", "wss://api.valr.com/v1/ws/trade")

logger = logging.getLogger(__name__)

# ── Mock state (injectable via /mock/* endpoints) ──────────────────────────

class ReplayState:
    def __init__(self):
        self.task:       asyncio.Task | None = None
        self.total:      int  = 0
        self.played:     int  = 0
        self.speed:      float = 1.0
        self.running:    bool = False
        self.finished:   bool = False

    @property
    def progress(self) -> float:
        return self.played / self.total if self.total > 0 else 0.0


class Portfolio:
    STARTING_USDT = 10_000.0

    def __init__(self):
        self.usdt:         float = self.STARTING_USDT
        self.btc:          float = 0.0
        self.avg_cost:     float = 0.0   # weighted avg purchase price of BTC held
        self.realized_pnl: float = 0.0
        self.total_trades: int   = 0

    def unrealized(self, price: float) -> float:
        return (price - self.avg_cost) * self.btc if self.btc > 0 else 0.0

    def total_value(self, price: float) -> float:
        return self.usdt + self.btc * price

    def total_pnl(self, price: float) -> float:
        return self.total_value(price) - self.STARTING_USDT

    def snapshot(self, price: float) -> dict:
        return {
            "usdt":          round(self.usdt, 4),
            "btc":           round(self.btc, 8),
            "avg_cost":      round(self.avg_cost, 2),
            "realized_pnl":  round(self.realized_pnl, 4),
            "unrealized_pnl":round(self.unrealized(price), 4),
            "total_value":   round(self.total_value(price), 4),
            "total_pnl":     round(self.total_pnl(price), 4),
        }


class MockState:
    def __init__(self):
        self.base_price:       float = 42_000.0
        self.volatility:       float = 0.0005      # tick-to-tick vol
        self.tick_interval_ms: int   = 100          # ms between synthetic ticks
        self.toxic_mode:       bool  = False        # VPIN spike injection
        self.toxic_duration_s: float = 0            # how long toxicity lasts
        self.toxic_started_at: float = 0
        self.rate_limit_active:bool  = False        # returns 429 on /orders
        self.latency_jitter_ms:int   = 0            # artificial delay on REST
        self.order_fill_mode:  str   = "immediate"  # "immediate" | "delayed" | "reject"
        self.reject_reason:    str   = "Insufficient balance"
        self.open_orders:      dict  = {}
        self.ws_clients:       list  = []
        self.replay:           ReplayState = ReplayState()
        self.portfolio:        Portfolio   = Portfolio()
        # Multi-pair synthetic prices — correlated with BTC by default
        # pearson ≈ 0.75 in LowVol; drops to ≈ 0.35 when toxic_mode is active
        self.eth_price:   float = 2_500.0
        self.sol_price:   float = 150.0
        # Binance lead-lag simulation: how many ms Binance leads VALR (positive = Binance leads)
        self.binance_lag_ms: float = 0.0
        # Sentiment WebSocket clients
        self.sentiment_clients: list = []
        # Live mode: True when relaying real VALR WS data; False = simulation
        self.valr_live: bool = False

_state = MockState()


# ── Lifespan: tick generator task ─────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    sim_task  = asyncio.create_task(_tick_generator())
    live_task = asyncio.create_task(_connect_valr_live())
    try:
        yield
    finally:
        for t in (sim_task, live_task):
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Mock VALR", version="0.1.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Tick generator ─────────────────────────────────────────────────────────

def _build_pair_events(pair: str, price: float, qty: float, side: str, now_iso: str) -> list[str]:
    """Build NEW_TRADE + AGGREGATED_ORDERBOOK_UPDATE JSON strings for a currency pair."""
    spread = price * 0.0001
    bids   = [[f"{price - spread * (i+1):.4f}", f"{random.uniform(0.1, 2.0):.4f}"] for i in range(10)]
    asks   = [[f"{price + spread * (i+1):.4f}", f"{random.uniform(0.1, 2.0):.4f}"] for i in range(10)]
    return [
        json.dumps({"type": "NEW_TRADE", "data": {
            "price": f"{price:.4f}", "quantity": f"{qty:.6f}",
            "takerSide": side, "tradedAt": now_iso, "currencyPair": pair,
        }}),
        json.dumps({"type": "AGGREGATED_ORDERBOOK_UPDATE", "data": {
            "Bids":       [{"price": b[0], "quantity": b[1]} for b in bids],
            "Asks":       [{"price": a[0], "quantity": a[1]} for a in asks],
            "LastChange": now_iso, "currencyPair": pair,
        }}),
    ]


async def _broadcast(events: list[str]):
    dead = []
    for ws in list(_state.ws_clients):
        for ev in events:
            try:
                await ws.send_text(ev)
            except Exception:
                dead.append(ws)
                break
    for ws in dead:
        try: _state.ws_clients.remove(ws)
        except ValueError: pass


def _valr_auth_headers(api_key: str, api_secret: str) -> dict:
    """Build VALR HMAC-SHA512 auth headers for WebSocket upgrade."""
    timestamp = str(int(time.time() * 1000))
    message   = f"{timestamp}GET/v1/ws/trade".encode()
    signature = hmac.new(api_secret.encode(), message, hashlib.sha512).hexdigest()
    return {
        "X-VALR-API-KEY":   api_key,
        "X-VALR-SIGNATURE": signature,
        "X-VALR-TIMESTAMP": timestamp,
    }


def _set_valr_source(live: bool) -> None:
    """Toggle live/sim flag and notify all connected browser clients."""
    if _state.valr_live == live:
        return
    _state.valr_live = live
    status = json.dumps({"type": "VALR_SOURCE", "live": live})
    asyncio.get_event_loop().create_task(_broadcast([status]))
    logger.info("VALR source → %s", "LIVE" if live else "SIMULATION")


async def _connect_valr_live() -> None:
    """Try to relay real VALR WS events to all browser clients.

    Requires VALR_API_KEY and VALR_API_SECRET env vars.
    Falls back to simulation (synthetic _tick_generator) if credentials are
    absent or the connection fails. Retries automatically on disconnect.
    """
    if not VALR_API_KEY or not VALR_API_SECRET:
        logger.info("VALR_API_KEY not set — running in simulation mode")
        return  # synthetic generator handles everything

    while True:
        try:
            headers = _valr_auth_headers(VALR_API_KEY, VALR_API_SECRET)
            async with websockets.connect(VALR_WS_URL, extra_headers=headers) as ws:
                await ws.send(json.dumps({
                    "type": "SUBSCRIBE",
                    "subscriptions": [
                        {"event": "NEW_TRADE",                  "pairs": ["BTCUSDT"]},
                        {"event": "AGGREGATED_ORDERBOOK_UPDATE","pairs": ["BTCUSDT"]},
                    ],
                }))
                _set_valr_source(live=True)
                logger.info("Connected to real VALR WS — live mode active")

                async for raw in ws:
                    # Keep base_price in sync so REST fills happen at correct price
                    try:
                        msg = json.loads(raw)
                        if msg.get("type") == "NEW_TRADE":
                            price = float(msg.get("data", {}).get("price", 0))
                            if price > 0:
                                _state.base_price = price
                    except Exception:
                        pass
                    await _broadcast([raw])

        except Exception as exc:
            logger.warning("VALR live WS disconnected (%s) — retrying in 5 s", exc)
            _set_valr_source(live=False)
            await asyncio.sleep(5)


async def _tick_generator():
    """Pushes synthetic VALR WebSocket events to all connected clients.

    Generates correlated BTC / ETH / SOL ticks:
      - Normal mode:  Pearson ≈ 0.75 (shared drift + independent noise)
      - Toxic mode:   Pearson ≈ 0.35 (correlation breaks down; BTC driven by informed flow)
    """
    tick = 0
    buy_vol  = 0.0
    sell_vol = 0.0
    EWMA_α   = 0.15

    while True:
        await asyncio.sleep(_state.tick_interval_ms / 1000)
        tick += 1

        # Pause while real VALR WS is relaying live data
        if _state.valr_live:
            continue

        # Price walk — BTC
        dr_btc = random.gauss(0, _state.volatility)
        _state.base_price *= math.exp(dr_btc)
        price = _state.base_price

        # Correlated alt-pair walks
        # Correlation coefficient target: 0.75 normal, 0.35 toxic
        # Achieved by mixing shared drift with independent noise.
        corr = 0.35 if _state.toxic_mode else 0.75
        vol_alt = _state.volatility * 0.8   # alts slightly less volatile than BTC

        shared_noise = dr_btc                          # shared component
        eth_noise    = (
            corr * shared_noise +
            math.sqrt(max(0, 1 - corr**2)) * random.gauss(0, vol_alt)
        )
        sol_noise    = (
            corr * shared_noise +
            math.sqrt(max(0, 1 - corr**2)) * random.gauss(0, vol_alt * 1.2)
        )
        _state.eth_price = max(1.0, _state.eth_price * math.exp(eth_noise))
        _state.sol_price = max(0.01, _state.sol_price * math.exp(sol_noise))

        # Toxic mode: skew volume heavily to one side
        if _state.toxic_mode:
            if time.time() - _state.toxic_started_at > _state.toxic_duration_s:
                _state.toxic_mode = False
            else:
                # 90% one-sided → VPIN spikes above 0.70
                qty  = random.uniform(0.5, 2.0)
                side = "buy" if tick % 10 < 9 else "sell"
        else:
            qty  = random.uniform(0.001, 0.5)
            side = "buy" if random.random() > 0.5 else "sell"

        buy_vol  = buy_vol  * (1 - EWMA_α) + (qty if side == "buy"  else 0) * EWMA_α
        sell_vol = sell_vol * (1 - EWMA_α) + (qty if side == "sell" else 0) * EWMA_α

        now_iso = _iso_now()

        # Broadcast all three pairs
        btc_qty  = qty
        eth_qty  = random.uniform(0.01, 5.0)
        sol_qty  = random.uniform(0.5, 50.0)
        eth_side = "buy" if random.random() > 0.5 else "sell"
        sol_side = "buy" if random.random() > 0.5 else "sell"

        all_events = (
            _build_pair_events("BTCUSDT", price, btc_qty, side, now_iso) +
            _build_pair_events("ETHUSDT", _state.eth_price, eth_qty, eth_side, now_iso) +
            _build_pair_events("SOLUSDT", _state.sol_price, sol_qty, sol_side, now_iso)
        )

        await _broadcast(all_events)



# ── WebSocket endpoint ─────────────────────────────────────────────────────

@app.websocket("/v1/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    _state.ws_clients.append(ws)
    # Immediately tell the new client whether we're live or simulated
    await ws.send_text(json.dumps({"type": "VALR_SOURCE", "live": _state.valr_live}))
    logger.info("Mock VALR WS client connected (%d total)", len(_state.ws_clients))
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            # Echo SUBSCRIBE ack
            if msg.get("type") == "SUBSCRIBE":
                await ws.send_text(json.dumps({"type": "SUBSCRIBED", "subscriptions": msg.get("subscriptions", [])}))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.debug("Mock WS error: %s", exc)
    finally:
        try: _state.ws_clients.remove(ws)
        except ValueError: pass


# ── REST endpoints (VALR-compatible) ──────────────────────────────────────

@app.get("/v1/public/time")
async def public_time():
    await _jitter()
    return {"epochTime": int(time.time() * 1000), "time": _iso_now()}


@app.get("/v1/marketdata/{pair}/orderbook")
async def get_orderbook(pair: str):
    await _jitter()
    price  = _state.base_price
    spread = price * 0.0001
    bids   = [{"price": f"{price - spread*(i+1):.2f}", "quantity": f"{random.uniform(0.1,2.0):.4f}", "orderCount": 1} for i in range(20)]
    asks   = [{"price": f"{price + spread*(i+1):.2f}", "quantity": f"{random.uniform(0.1,2.0):.4f}", "orderCount": 1} for i in range(20)]
    return {"Bids": bids, "Asks": asks, "LastChange": _iso_now()}


@app.post("/v1/orders/limit")
@app.post("/v1/orders/market")
async def submit_order(request: dict | None = None):
    await _jitter()

    if _state.rate_limit_active:
        return JSONResponse(
            status_code=429,
            content={"message": "Too many requests"},
            headers={"Retry-After": "5"},
        )

    if _state.order_fill_mode == "reject":
        raise HTTPException(status_code=400, detail=_state.reject_reason)

    body       = request or {}
    side       = body.get("side", "buy").lower()
    fill_price = _state.base_price
    p          = _state.portfolio

    # Sensible quantity: 1% of USDT balance per order (capped by actual holdings)
    raw_qty = float(body.get("quantity", 0.0) or 0.0)
    if raw_qty <= 0:
        raw_qty = p.usdt * 0.01 / fill_price  # fallback: 1% of balance

    pnl_realized = 0.0

    if side == "buy":
        cost = fill_price * raw_qty
        if cost > p.usdt:
            raw_qty = p.usdt / fill_price  # partial fill to available USDT
            cost    = p.usdt
        if raw_qty < 1e-8:
            raise HTTPException(status_code=400, detail="Insufficient USDT balance")
        old_btc = p.btc
        p.usdt  -= cost
        p.btc   += raw_qty
        p.avg_cost = (p.avg_cost * old_btc + cost) / p.btc
        p.total_trades += 1

    else:  # sell
        fill_qty = min(raw_qty, p.btc)
        if fill_qty < 1e-8:
            raise HTTPException(status_code=400, detail="Insufficient BTC balance")
        raw_qty       = fill_qty
        revenue       = fill_price * raw_qty
        pnl_realized  = (fill_price - p.avg_cost) * raw_qty
        p.usdt        += revenue
        p.btc         -= raw_qty
        p.realized_pnl += pnl_realized
        if p.btc < 1e-8:
            p.btc      = 0.0
            p.avg_cost = 0.0
        p.total_trades += 1

    order_id = str(uuid.uuid4())
    order = {
        "id":           order_id,
        "status":       "FILLED",
        "side":         side,
        "pair":         "BTCUSDT",
        "filled_price": round(fill_price, 2),
        "filled_qty":   round(raw_qty, 8),
        "pnl_realized": round(pnl_realized, 4),
        "placedAt":     _iso_now(),
        "portfolio":    p.snapshot(fill_price),
    }
    _state.open_orders[order_id] = order
    return order


@app.get("/v1/account/balances")
async def account_balances():
    p = _state.portfolio
    return p.snapshot(_state.base_price)


@app.get("/v1/account/fees")
async def account_fees():
    """Return VALR-equivalent fee tier (taker 0.10%, maker 0.05%)."""
    return {
        "maker_fee": 0.0005,
        "taker_fee": 0.001,
        "fee_tier":  "standard",
    }


@app.post("/mock/portfolio/reset")
async def reset_portfolio():
    _state.portfolio = Portfolio()
    return {"status": "reset", "starting_usdt": Portfolio.STARTING_USDT}


@app.delete("/v1/orders/{symbol}")
async def cancel_orders(symbol: str):
    await _jitter()
    cancelled = list(_state.open_orders.keys())
    _state.open_orders.clear()
    return {"cancelled": cancelled}


@app.get("/v1/orders/open")
async def open_orders():
    return list(_state.open_orders.values())


# ── Retrain endpoint ───────────────────────────────────────────────────────

class OutcomeRecord(BaseModel):
    features:   list[float]   # 13 floats: [momentum, z_score, vwap_dev, imbalance,
                              #  vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev,
                              #  cost_basis_dev, unrealized_pnl_norm, pos_size_norm,
                              #  sentiment_score, sentiment_momentum]
                              # Narrower legacy vectors (8 or 11 features) are padded in _do_retrain.
    outcome:    int           # 1 = profitable fill, 0 = loss
    pnl:        float
    pattern_id: str
    regime_tag: str
    p_up:       float         # model's prediction at trade time (for drift monitoring)
    timestamp:  int


@app.post("/mock/retrain")
async def retrain_model(outcomes: list[OutcomeRecord]):
    """
    Retrain the signal model on real fill outcomes and return updated ONNX bytes.

    Strategy: blend real outcomes (weighted 5×) with a fresh synthetic baseline
    so the model adapts to real market behaviour without overfitting to a handful
    of trades.
    """
    import asyncio
    from fastapi.responses import Response, JSONResponse
    loop = asyncio.get_event_loop()
    try:
        onnx_bytes = await loop.run_in_executor(None, _do_retrain, outcomes)
    except Exception as exc:
        logger.exception("Retrain failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)
    return Response(content=onnx_bytes, media_type="application/octet-stream")


def _do_retrain(outcomes: list[OutcomeRecord]) -> bytes:
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    rng = np.random.default_rng(42)
    N_SYN = 3_000  # synthetic baseline keeps the model stable on sparse real data

    # Infer target feature count from real outcomes; default to 13 (current full vector).
    # Supported widths: 8 (legacy), 11 (position context), 13 (+ sentiment).
    n_real_feat = outcomes[0].features.__len__() if outcomes else 13
    n_target    = max(n_real_feat, 13)  # always build at least 13-wide synthetic baseline

    # ── Synthetic baseline ───────────────────────────────────────────────────
    momentum     = rng.laplace(0, 0.0015,   N_SYN)
    z_score      = rng.normal(0, 1.2,       N_SYN)
    vwap_dev     = rng.normal(0, 0.0015,    N_SYN)
    imbalance    = rng.uniform(-1, 1,       N_SYN)
    vol_ratio    = np.clip(rng.normal(0, 0.3, N_SYN), -1, 1)
    spread_norm  = rng.exponential(0.00015, N_SYN)
    ema_fast_dev = rng.normal(0, 0.001,     N_SYN)
    ema_slow_dev = rng.normal(0, 0.0015,    N_SYN)

    X_syn8 = np.column_stack([
        momentum, z_score, vwap_dev, imbalance,
        vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev,
    ])
    # Position context features (flat position for synthetic baseline)
    X_syn11 = np.column_stack([X_syn8, np.zeros((N_SYN, 3))])
    # Sentiment features: score ~ N(0, 0.3) clipped, momentum ~ N(0, 0.1)
    sentiment_score    = np.clip(rng.normal(0, 0.3, N_SYN), -1, 1)
    sentiment_momentum = np.clip(rng.normal(0, 0.1, N_SYN), -1, 1)
    X_syn13 = np.column_stack([X_syn11, sentiment_score, sentiment_momentum])
    # Pad further if future feature additions push n_target > 13
    extra = n_target - 13
    X_syn  = np.column_stack([X_syn13, np.zeros((N_SYN, extra))]) if extra > 0 else X_syn13

    signal = (
         2.5 * np.tanh(momentum  * 600) +
        -1.2 * np.tanh(z_score   * 0.7) +
         0.8 * np.tanh(vwap_dev  * 400) +
         0.7 * np.tanh(imbalance * 3.0) +
         0.6 * np.tanh(vol_ratio * 3.0) +
        -0.3 * spread_norm * 1000       +
         0.5 * np.tanh(ema_fast_dev * 800) +
         0.3 * np.tanh(ema_slow_dev * 600) +
         0.4 * np.tanh(sentiment_score * 3.0)  # sentiment boosts signal slightly
    )
    y_syn = (signal + rng.normal(0, 0.9, N_SYN) > 0).astype(int)

    # ── Real outcomes (5× weight via repetition) ────────────────────────────
    if outcomes:
        X_real = np.array([o.features for o in outcomes], dtype=float)
        y_real = np.array([o.outcome  for o in outcomes], dtype=int)
        # Pad narrower historical outcomes up to n_target with zeros
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
            hidden_layer_sizes=(64, 32, 16),
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
    pipe.fit(X, y)

    initial_type = [("float_input", FloatTensorType([None, n_feat]))]
    onnx_model   = convert_sklearn(pipe, initial_types=initial_type,
                                   target_opset=17, options={"zipmap": False})
    onnx_bytes   = onnx_model.SerializeToString()
    logger.info("Retrain complete — %d real + %d synthetic samples → %d KB  features=%d",
                len(outcomes), N_SYN, len(onnx_bytes) // 1024, n_feat)
    return onnx_bytes


# ── Mock control API (dev/test only) ──────────────────────────────────────

class ToxicityInject(BaseModel):
    duration_seconds: float = 10.0
    volatility_spike: float = 0.005


class LatencyConfig(BaseModel):
    jitter_ms: int = 0


class RateLimitConfig(BaseModel):
    active: bool = True


class OrderFillConfig(BaseModel):
    mode: str = "immediate"      # "immediate" | "delayed" | "reject"
    reject_reason: str = "Insufficient balance"


class PriceConfig(BaseModel):
    base_price: float
    volatility: float = 0.0005


class BinanceLagConfig(BaseModel):
    lag_ms: float = 0.0   # simulated VALR-behind-Binance lag in ms (positive = VALR lags)


class ReplayTick(BaseModel):
    price:     float
    quantity:  float
    takerSide: str          # "buy" | "sell"
    tradedAt:  str          # ISO-8601


class ReplayConfig(BaseModel):
    ticks: list[ReplayTick]
    speed: float = 1.0      # 1.0 = real-time, 10.0 = 10× faster
    pair:  str   = "BTCUSDT"


# ── LLM Strategy Planner ─────────────────────────────────────────────────────

class PlanRequest(BaseModel):
    intent:         str
    ollama_url:     str  = "http://localhost:11434"
    model:          str  = "gemma4:e2b"
    market_context: dict = {}   # {price, regime, vpin, portfolio_value}


class StrategyPlan(BaseModel):
    strategy_name:           str
    rationale:               str
    target_pnl_pct:          float
    time_horizon_ms:         int
    stop_loss_pct:           float
    autonomy_level:          float
    max_position_pct:        float
    preferred_patterns:      list[str]
    vetoed_patterns:         list[str]
    regime_caps:             dict
    review_interval_ms:      int   = 120_000
    review_pnl_delta_pct:    float = 2.0
    review_on_regime_change: bool  = True


class ReviewRequest(BaseModel):
    original_plan:       dict
    current_state:       dict
    echo_snapshot:       list[dict]
    last_fills:          list[dict]
    recent_discoveries:  list[dict] = []   # latest PatternInsights from discovery loop
    review_count:        int
    trigger_reason:      str
    ollama_url:          str  = "http://localhost:11434"
    model:               str  = "gemma4:e2b"


class PlanAdjustment(BaseModel):
    autonomy_level:     float
    max_position_pct:   float
    preferred_patterns: list[str]
    vetoed_patterns:    list[str]
    regime_caps:        dict
    target_pnl_pct:     float
    stop_loss_pct:      float
    terminate:          bool  = False
    rationale:          str


class DiscoverRequest(BaseModel):
    fills:        list[dict]   # [{features, outcome, pnl, regime_tag, pattern_id, p_up}]
    current_phic: dict = {}
    ollama_url:   str  = "http://localhost:11434"
    model:        str  = "gemma4:e2b"


class TuneRequest(BaseModel):
    session:        dict             # session_recorder.js export {decisions, outcomes, events}
    decay_range:    list[float] = [0.005, 0.20, 12]   # [lo, hi, n]
    loss_range:     list[float] = [2.0,  10.0,  12]   # [lo, hi, n]
    survival_floor: float       = 0.30
    top_n:          int         = 5


_ALL_PATTERNS = {"MOMENTUM_V1", "DEPTH_GRAB", "REVERSION_A", "SPREAD_FADE"}

_FALLBACK_PLAN: dict = {
    "strategy_name":           "Conservative Default",
    "rationale":               "Ollama unreachable — using safe defaults",
    "target_pnl_pct":          5.0,
    "time_horizon_ms":         300_000,
    "stop_loss_pct":           2.0,
    "autonomy_level":          0.5,
    "max_position_pct":        20,
    "preferred_patterns":      ["MOMENTUM_V1"],
    "vetoed_patterns":         [],
    "regime_caps":             {"Crisis": 0},
    "review_interval_ms":      120_000,
    "review_pnl_delta_pct":    2.0,
    "review_on_regime_change": True,
}

_PLAN_SYSTEM_PROMPT = """
You are a trading strategy planner for EchoForge, a mesh-based algorithmic trading system.
Translate the user's goal into a StrategyPlan JSON object.

AVAILABLE PATTERNS (use exact names):
- MOMENTUM_V1  (momentum — good for trending, short horizons)
- DEPTH_GRAB   (momentum — aggressive, uses order book depth)
- REVERSION_A  (mean-reversion — good for ranging, longer horizons)
- SPREAD_FADE  (mean-reversion — slow, low risk)

REGIMES: LowVol, HighVol, Crisis. Always set {"Crisis": 0} in regime_caps.

TIME: time_horizon_ms is MILLISECONDS. Examples: 5 min=300000, 10 min=600000, 30 min=1800000, 1 hour=3600000.

REVIEW TRIGGERS (set these in your plan — the system will call you back):
- review_interval_ms: how often to check in (60000–300000ms). Short horizons = frequent.
- review_pnl_delta_pct: call back when PnL moves by this much (0.5–5.0%). Aggressive = tighter.
- review_on_regime_change: true if regime shifts should trigger a review.

RISK RULES:
- stop_loss_pct = 25–40% of target_pnl_pct
- autonomy_level 0.8–1.0 for aggressive, 0.3–0.5 for conservative
- max_position_pct controls what fraction (%) of portfolio each trade can use (1–100)
- Short horizons (<5min): prefer MOMENTUM_V1, DEPTH_GRAB; higher autonomy + larger position size
- Long horizons (>15min): REVERSION_A, SPREAD_FADE viable; moderate autonomy

RESPOND WITH ONLY this JSON (no markdown, no extra text):
{"strategy_name":"...","rationale":"...","target_pnl_pct":0.0,"time_horizon_ms":0,
"stop_loss_pct":0.0,"autonomy_level":0.0,"max_position_pct":0,"preferred_patterns":[],
"vetoed_patterns":[],"regime_caps":{},"review_interval_ms":120000,
"review_pnl_delta_pct":2.0,"review_on_regime_change":true}
"""

_REVIEW_SYSTEM_PROMPT = """
You are a live trading strategy monitor for EchoForge. You review in-progress plans.
Based on performance and echo state, return a PlanAdjustment to recalibrate.

Echo states: "active" (executing), "hibernating" (low aliveness, paper-trading), "dead" (quorum vetoed).
net_aliveness 0–1: higher = more confident/active. shadow_aliveness = paper-trade tracker.

ADJUSTMENT RULES:
- If a preferred pattern is "dead" or "hibernating": move it to vetoed, promote another.
- If PnL is falling behind: increase autonomy_level (max 1.0), widen max_position_pct.
- If PnL is ahead of schedule: reduce risk (lower autonomy_level) to lock in gains.
- If regime is Crisis: set terminate=true unless target is already nearly reached.
- Set terminate=true if remaining time < 20% AND pnl_pct < 10% of target.
- max_position_pct controls what % of portfolio each trade uses — raise it to trade larger.
- recent_discoveries: apply high-confidence (>0.7) pattern insights — adopt their suggested_phic if consistent with current performance.

RESPOND WITH ONLY this JSON (no markdown, no extra text):
{"autonomy_level":0.0,"max_position_pct":0,"preferred_patterns":[],"vetoed_patterns":[],
"regime_caps":{},"target_pnl_pct":0.0,"stop_loss_pct":0.0,"terminate":false,"rationale":"..."}
"""

_DISCOVER_SYSTEM_PROMPT = """
You are a quantitative pattern analyst for EchoForge. Analyze recent fill history to discover profitable conditions.

Feature index: 0=momentum, 1=z_score, 2=vwap_dev, 3=imbalance, 4=vol_ratio, 5=spread_norm, 6=ema_fast_dev, 7=ema_slow_dev
Fill format: f=[8 features], o=outcome(1=win/0=loss), pnl=realized_pnl, r=regime, p=pattern_id, pu=ML_confidence(0-1)

Find up to 3 discoveries:
1. Which regime+pattern combinations have the highest win rate
2. Feature thresholds that correlate with wins (e.g. "z_score>1.2 → 80% win rate")
3. Any emerging profitable condition worth naming as a new strategy

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
    # Sanitise time horizon: must be 30s–1h
    # Models often output 10× too large (600s confusion → 6000000 instead of 600000);
    # if value > 3 600 000 ms (1h) and is divisible by 10, divide down until ≤ 1h.
    horizon = int(raw.get("time_horizon_ms", 300_000))
    while horizon > 3_600_000 and horizon % 10 == 0:
        horizon //= 10
    raw["time_horizon_ms"] = max(30_000, min(3_600_000, horizon))
    # Stop-loss must be < target and 20–50% of target (not an absolute %)
    target = float(raw.get("target_pnl_pct", 5.0))
    stop   = float(raw.get("stop_loss_pct",  target * 0.3))
    if stop >= target:              # LLM confused absolute vs relative
        stop = target * 0.3
    raw["stop_loss_pct"] = round(max(0.1, stop), 2)
    preferred = set(raw.get("preferred_patterns") or []) & _ALL_PATTERNS
    if not preferred:
        preferred = {"MOMENTUM_V1"}
    raw["preferred_patterns"] = list(preferred)
    raw["vetoed_patterns"]    = list(_ALL_PATTERNS - preferred)
    caps = dict(raw.get("regime_caps") or {})
    # Keep only explicitly non-zero HighVol/LowVol caps; always force Crisis=0
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


def _call_ollama_plan(intent: str, ollama_url: str, model: str) -> dict:
    raw = _ollama_chat(ollama_url, model, _PLAN_SYSTEM_PROMPT, intent)
    if raw is None:
        raw = _ollama_chat(ollama_url, model, _PLAN_SYSTEM_PROMPT, intent)  # one retry
    if raw is None:
        logger.warning("Ollama unreachable — returning fallback plan")
        return dict(_FALLBACK_PLAN)
    return _clamp_plan(raw)


def _call_ollama_review(payload: str, ollama_url: str, model: str) -> dict | None:
    raw = _ollama_chat(ollama_url, model, _REVIEW_SYSTEM_PROMPT, payload)
    if raw is None:
        return None
    return _clamp_plan(raw)


def _call_ollama_discover(fills: list, current_phic: dict, ollama_url: str, model: str) -> list:
    import json as _json
    # Compact fill representation to fit small-model context window (last 50 fills)
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
                # Merge with stub values so _clamp_plan can sanitise safely
                sanitized = _clamp_plan({
                    "target_pnl_pct":  5.0,
                    "time_horizon_ms": 300_000,
                    "stop_loss_pct":   2.0,
                    **phic,
                })
                phic = {k: sanitized[k]
                        for k in ("autonomy_level", "max_position_pct",
                                  "preferred_patterns", "vetoed_patterns", "regime_caps")
                        if k in sanitized}
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


# ── Replay task ────────────────────────────────────────────────────────────

async def _run_replay(ticks: list[ReplayTick], speed: float, pair: str):
    rs = _state.replay
    rs.total   = len(ticks)
    rs.played  = 0
    rs.speed   = speed
    rs.running = True
    rs.finished = False

    try:
        prev_ts: float | None = None
        for tick in ticks:
            # Parse ISO timestamp → epoch ms for interval calculation
            from datetime import datetime, timezone
            try:
                dt = datetime.fromisoformat(tick.tradedAt.replace("Z", "+00:00"))
                ts = dt.timestamp()
            except Exception:
                ts = time.time()

            if prev_ts is not None:
                real_gap = ts - prev_ts
                if real_gap > 0:
                    await asyncio.sleep(max(real_gap / speed, 0.001))
            prev_ts = ts

            # Update base price for REST orderbook consistency
            _state.base_price = tick.price

            price = tick.price
            spread = price * 0.0001
            bids = [[f"{price - spread*(i+1):.2f}", f"{random.uniform(0.1,2.0):.4f}"] for i in range(10)]
            asks = [[f"{price + spread*(i+1):.2f}", f"{random.uniform(0.1,2.0):.4f}"] for i in range(10)]

            trade_event = json.dumps({
                "type": "NEW_TRADE",
                "data": {
                    "price":        f"{tick.price:.2f}",
                    "quantity":     f"{tick.quantity:.6f}",
                    "takerSide":    tick.takerSide,
                    "tradedAt":     tick.tradedAt,
                    "currencyPair": pair,
                },
            })
            book_event = json.dumps({
                "type": "AGGREGATED_ORDERBOOK_UPDATE",
                "data": {
                    "Bids":         [{"price": b[0], "quantity": b[1]} for b in bids],
                    "Asks":         [{"price": a[0], "quantity": a[1]} for a in asks],
                    "LastChange":   tick.tradedAt,
                    "currencyPair": pair,
                },
            })

            dead = []
            for ws in list(_state.ws_clients):
                try:
                    await ws.send_text(trade_event)
                    await ws.send_text(book_event)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                try: _state.ws_clients.remove(ws)
                except ValueError: pass

            rs.played += 1

    except asyncio.CancelledError:
        pass
    finally:
        rs.running  = False
        rs.finished = True
        logger.info("Replay finished: %d/%d ticks played", rs.played, rs.total)


@app.post("/mock/replay")
async def start_replay(cfg: ReplayConfig):
    """Feed a recorded session back through the WS at configurable speed."""
    rs = _state.replay
    if rs.running and rs.task and not rs.task.done():
        rs.task.cancel()
        try:
            await rs.task
        except asyncio.CancelledError:
            pass

    rs.task = asyncio.create_task(_run_replay(cfg.ticks, cfg.speed, cfg.pair))
    logger.info("Replay started: %d ticks at %.1f×", len(cfg.ticks), cfg.speed)
    return {"status": "started", "total": len(cfg.ticks), "speed": cfg.speed}


@app.get("/mock/replay/status")
async def replay_status():
    rs = _state.replay
    return {
        "running":  rs.running,
        "finished": rs.finished,
        "total":    rs.total,
        "played":   rs.played,
        "progress": round(rs.progress, 4),
        "speed":    rs.speed,
    }


@app.post("/mock/replay/stop")
async def stop_replay():
    rs = _state.replay
    if rs.task and not rs.task.done():
        rs.task.cancel()
        try:
            await rs.task
        except asyncio.CancelledError:
            pass
    return {"status": "stopped", "played": rs.played, "total": rs.total}


@app.post("/mock/plan")
async def generate_plan(req: PlanRequest):
    loop = asyncio.get_event_loop()
    try:
        plan = await loop.run_in_executor(
            None, _call_ollama_plan, req.intent, req.ollama_url, req.model
        )
    except Exception as exc:
        logger.warning("generate_plan failed: %s", exc)
        return JSONResponse(content=dict(_FALLBACK_PLAN))
    logger.info("Plan: %s  target=%.1f%%  horizon=%ds  auto=%.2f  pos=%d%%",
        plan.get("strategy_name"), plan.get("target_pnl_pct", 0),
        plan.get("time_horizon_ms", 0) // 1000,
        plan.get("autonomy_level", 0), plan.get("max_position_pct", 0))
    return JSONResponse(content=plan)


@app.post("/mock/plan/review")
async def review_plan(req: ReviewRequest):
    import json as _json
    payload = _json.dumps({
        "current_state":     req.current_state,
        "echo_snapshot":     req.echo_snapshot,
        "last_fills":        req.last_fills,
        "recent_discoveries": req.recent_discoveries,
        "review_count":      req.review_count,
        "trigger_reason":    req.trigger_reason,
        "original_plan":     {k: req.original_plan.get(k)
                              for k in ("strategy_name", "target_pnl_pct",
                                        "time_horizon_ms", "stop_loss_pct")},
    })
    loop = asyncio.get_event_loop()
    adj = await loop.run_in_executor(
        None, _call_ollama_review, payload, req.ollama_url, req.model
    )
    if adj is None:
        logger.warning("Review LLM call failed — no adjustment applied")
        return JSONResponse(content={"terminate": False, "rationale": "LLM unavailable — no change"})
    logger.info("Review #%d [%s]: %s | terminate=%s  auto=%.2f  pos=%d%%",
        req.review_count, req.trigger_reason,
        adj.get("rationale", "")[:60], adj.get("terminate"),
        adj.get("autonomy_level", 0), adj.get("max_position_pct", 0))
    return JSONResponse(content=adj)


@app.post("/mock/plan/discover")
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


@app.post("/mock/tune-decay")
async def tune_decay(req: TuneRequest):
    """
    Grid-search optimal (decay_rate, loss_multiplier) from a session export.
    Uses the exact EWMA formula from echoforge_worker.js.
    """
    loop   = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _run_decay_grid, req)
    except Exception as exc:
        logger.warning("tune_decay failed: %s", exc)
        return JSONResponse(content={"error": str(exc)}, status_code=500)
    return JSONResponse(content=result)


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
        # Build per-pattern FIFO outcome queues
        fifo: dict = defaultdict(deque)
        for o in outcomes:
            pid = o.get("pattern_id")
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
                alpha = min(decay_rate * loss_mult, 1.0) if sc < 0 else decay_rate
                aliveness = max(0.0, min(1.0, aliveness * (1 - alpha) + normalised * alpha))

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
    decay_vals = _linspace(dr_lo, dr_hi, dr_n)
    loss_vals  = _linspace(lm_lo, lm_hi, lm_n)

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


@app.post("/mock/toxicity")
async def inject_toxicity(cfg: ToxicityInject):
    """Inject a VPIN toxicity spike — triggers Nociceptor CANCEL_ORDERS."""
    _state.toxic_mode       = True
    _state.toxic_duration_s = cfg.duration_seconds
    _state.toxic_started_at = time.time()
    _state.volatility       = cfg.volatility_spike
    logger.info("Mock: toxicity injected for %.1fs", cfg.duration_seconds)
    return {"status": "injected", "duration_seconds": cfg.duration_seconds}


@app.post("/mock/toxicity/clear")
async def clear_toxicity():
    _state.toxic_mode = False
    _state.volatility = 0.0005
    return {"status": "cleared"}


@app.post("/mock/latency")
async def set_latency(cfg: LatencyConfig):
    """Add artificial REST response latency to test Proprioceptor."""
    _state.latency_jitter_ms = cfg.jitter_ms
    return {"status": "set", "jitter_ms": cfg.jitter_ms}


@app.post("/mock/rate-limit")
async def set_rate_limit(cfg: RateLimitConfig):
    """Toggle 429 responses on /orders to test SAF queue fallback."""
    _state.rate_limit_active = cfg.active
    return {"status": "rate_limit_active" if cfg.active else "rate_limit_cleared"}


@app.post("/mock/order-fill")
async def set_order_fill(cfg: OrderFillConfig):
    """Control order fill behaviour: immediate, delayed, or reject."""
    _state.order_fill_mode = cfg.mode
    _state.reject_reason   = cfg.reject_reason
    return {"status": "set", "mode": cfg.mode}


@app.post("/mock/price")
async def set_price(cfg: PriceConfig):
    """Override the synthetic price and volatility."""
    _state.base_price = cfg.base_price
    _state.volatility = cfg.volatility
    return {"status": "set", "base_price": cfg.base_price}


@app.post("/mock/calibrate-thresholds")
async def calibrate_thresholds(req: dict):
    """
    Compute regime thresholds from empirical VPIN samples collected by the browser.
    Returns percentile-based thresholds so regime boundaries reflect observed distribution.
    """
    import numpy as np
    samples = req.get("samples", [])
    if len(samples) < 30:
        return JSONResponse(content={"error": "Need at least 30 samples"}, status_code=400)
    arr = np.clip(np.array(samples, dtype=float), 0, 1)
    percentiles = {f"p{p}": float(np.percentile(arr, p)) for p in [25, 50, 75, 90, 95, 99]}
    # HighVol threshold: p75 — activity that's unusual but not rare
    # Crisis threshold:  p95 — genuinely exceptional flow
    highvol  = float(np.percentile(arr, 75))
    crisis   = float(np.percentile(arr, 95))
    logger.info("Calibration: %d samples  HighVol=%.3f  Crisis=%.3f", len(arr), highvol, crisis)
    return {
        "vpin_highvol_threshold": round(highvol, 4),
        "vpin_crisis_threshold":  round(crisis,  4),
        "sample_count": len(arr),
        **percentiles,
    }


class PretrainRequest(BaseModel):
    lookback_days:  int   = 3       # how many days of 1-min Binance klines to fetch
    forward_bars:   int   = 5       # minutes ahead used to label the trade direction
    min_edge_pct:   float = 0.001   # minimum price move required to label as profitable (≥ taker fee)
    symbol:         str   = "BTCUSDT"
    n_features:     int   = 13      # 8 market + 3 position context + 2 sentiment (score, momentum)


@app.post("/mock/pretrain-historical")
async def pretrain_historical(req: PretrainRequest):
    """
    Fetch real Binance 1-minute klines, compute the same 8 ONNX features used at
    inference time, label with forward price movement, train the MLP, and return
    the updated ONNX bytes for hot-swap into the browser inference worker.
    """
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, _do_pretrain_historical, req)
    except Exception as exc:
        logger.error("pretrain-historical failed: %s", exc)
        return JSONResponse(content={"error": str(exc)}, status_code=500)
    return JSONResponse(content=result)


def _fetch_klines(symbol: str, interval: str, limit: int, end_time_ms: int | None = None) -> list:
    import requests as _req
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    if end_time_ms:
        params["endTime"] = end_time_ms
    r = _req.get("https://api.binance.com/api/v3/klines", params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def _do_pretrain_historical(req: PretrainRequest) -> bytes:
    import numpy as np
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from skl2onnx import convert_sklearn
    from skl2onnx.common.data_types import FloatTensorType

    # ── Fetch klines (max 1000 per call; page backwards to cover lookback_days) ─
    bars_needed = req.lookback_days * 24 * 60 + req.forward_bars + 50
    all_klines: list = []
    end_time = None
    while len(all_klines) < bars_needed:
        batch = _fetch_klines(req.symbol, "1m", 1000, end_time)
        if not batch:
            break
        all_klines = batch + all_klines
        end_time = int(batch[0][0]) - 1   # fetch page before this batch
        if len(batch) < 1000:
            break

    if len(all_klines) < req.forward_bars + 30:
        raise RuntimeError(f"Only {len(all_klines)} klines returned — Binance may be unreachable")

    logger.info("pretrain-historical: %d klines fetched for %s", len(all_klines), req.symbol)

    # ── Parse into arrays ────────────────────────────────────────────────────
    closes  = np.array([float(k[4])  for k in all_klines])
    highs   = np.array([float(k[2])  for k in all_klines])
    lows    = np.array([float(k[3])  for k in all_klines])
    volumes = np.array([float(k[5])  for k in all_klines])
    taker_buy_vol = np.array([float(k[9]) for k in all_klines])  # taker buy base volume

    n = len(closes)

    # ── Compute EMA (same α as orderbook_worker: fast≈5-bar, slow≈20-bar) ────
    α_fast, α_slow = 0.18, 0.09
    ema_fast = np.zeros(n); ema_fast[0] = closes[0]
    ema_slow = np.zeros(n); ema_slow[0] = closes[0]
    for i in range(1, n):
        ema_fast[i] = ema_fast[i-1] + α_fast * (closes[i] - ema_fast[i-1])
        ema_slow[i] = ema_slow[i-1] + α_slow * (closes[i] - ema_slow[i-1])

    # ── Rolling VWAP (30-bar window) ─────────────────────────────────────────
    vwap = np.zeros(n)
    for i in range(n):
        w = max(0, i - 29)
        v_sum = np.sum(volumes[w:i+1])
        vwap[i] = np.sum(closes[w:i+1] * volumes[w:i+1]) / v_sum if v_sum > 0 else closes[i]

    # ── Rolling z-score (30-bar window) ──────────────────────────────────────
    z_score = np.zeros(n)
    for i in range(29, n):
        w = closes[i-29:i+1]
        std = np.std(w) or 1.0
        z_score[i] = (closes[i] - np.mean(w)) / std

    # ── Rolling volume EWMA for vol_ratio ────────────────────────────────────
    ewma_vol = np.zeros(n); ewma_vol[0] = volumes[0]
    for i in range(1, n):
        ewma_vol[i] = ewma_vol[i-1] * 0.95 + volumes[i] * 0.05

    # ── Build feature matrix ─────────────────────────────────────────────────
    # Features must match inference_worker.js order:
    # [momentum, z_score, vwap_dev, imbalance, vol_ratio, spread_norm, ema_fast_dev, ema_slow_dev]
    momentum     = (ema_fast - ema_slow) / np.where(ema_slow > 0, ema_slow, 1)
    vwap_dev     = np.where(vwap > 0, (vwap - closes) / vwap, 0)
    imbalance    = np.where(volumes > 0,
                       (taker_buy_vol / volumes - 0.5) * 2, 0)   # [-1,1]
    vol_ratio    = np.where(ewma_vol > 0,
                       np.clip((volumes - ewma_vol) / ewma_vol, -1, 1), 0)
    spread_norm  = (highs - lows) / np.where(closes > 0, closes, 1)
    ema_fast_dev = (ema_fast - closes) / np.where(closes > 0, closes, 1)
    ema_slow_dev = (ema_slow - closes) / np.where(closes > 0, closes, 1)

    # ── Label: did price rise by ≥ min_edge_pct in forward_bars minutes? ─────
    start = 30   # skip warm-up
    end   = n - req.forward_bars
    idx   = np.arange(start, end)

    fwd_return = (closes[idx + req.forward_bars] - closes[idx]) / closes[idx]
    y = (fwd_return > req.min_edge_pct).astype(int)

    # 8 market microstructure features (always present)
    X8 = np.column_stack([
        momentum[idx], z_score[idx], vwap_dev[idx], imbalance[idx],
        vol_ratio[idx], spread_norm[idx], ema_fast_dev[idx], ema_slow_dev[idx],
    ])

    if req.n_features >= 11:
        # 3 position context features — simulated as flat (0) for historical data.
        zeros3 = np.zeros((len(idx), 3))
        X11 = np.column_stack([X8, zeros3])
    else:
        X11 = X8

    if req.n_features >= 13:
        # 2 sentiment features — simulated as neutral (0) for historical kline data.
        # Live inference supplies real sentiment score and momentum.
        X = np.column_stack([X11, np.zeros((len(idx), 2))])
    else:
        X = X11

    # Sanity: need both classes
    if len(np.unique(y)) < 2:
        raise RuntimeError("Labels are all one class — check min_edge_pct or data quality")

    logger.info("pretrain-historical: %d samples  label_rate=%.1f%%", len(y), y.mean() * 100)

    # ── Train (same architecture as _do_retrain) ─────────────────────────────
    pipe = Pipeline([
        ("scaler", StandardScaler()),
        ("mlp",    MLPClassifier(
            hidden_layer_sizes=(64, 32, 16),
            activation="relu",
            solver="adam",
            max_iter=500,
            random_state=42,
            alpha=0.0005,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=15,
            # class_weight not supported by MLPClassifier — use sample_weight below
        )),
    ])
    # Balance classes via sample weights so the model doesn't collapse to "always predict 0"
    pos_rate = y.mean()
    if 0 < pos_rate < 1:
        w = np.where(y == 1, (1 - pos_rate) / pos_rate, 1.0)
    else:
        w = np.ones(len(y))
    pipe.fit(X, y, mlp__sample_weight=w)
    accuracy = float(pipe.score(X, y))

    import base64 as _b64
    n_feat = X.shape[1]
    initial_type = [("float_input", FloatTensorType([None, n_feat]))]
    onnx_model   = convert_sklearn(pipe, initial_types=initial_type,
                                   target_opset=17, options={"zipmap": False})
    onnx_bytes   = onnx_model.SerializeToString()
    logger.info("pretrain-historical complete — %d KB, %.1f%% label rate  acc=%.1f%%  features=%d",
                len(onnx_bytes) // 1024, y.mean() * 100, accuracy * 100, n_feat)
    return {
        "onnx_b64":      _b64.b64encode(onnx_bytes).decode(),
        "samples":       int(len(y)),
        "accuracy":      round(accuracy, 4),
        "positive_rate": round(float(y.mean()), 4),
        "n_features":    n_feat,
    }


@app.post("/mock/binance-lag")
async def set_binance_lag(cfg: BinanceLagConfig):
    """Set simulated Binance lead-lag (positive = Binance leads VALR by N ms).
    Used to test cross-exchange arb detection in correlation_worker."""
    _state.binance_lag_ms = cfg.lag_ms
    return {"status": "set", "lag_ms": cfg.lag_ms}


@app.websocket("/mock/sentiment")
async def sentiment_feed(ws: WebSocket):
    """
    Synthetic sentiment WebSocket feed — clients receive scores every 2s.

    Message format: {"score": float[-1,+1], "momentum": float[-1,+1], "timestamp": ms}

    Sentiment follows regime (regime inferred from toxic_mode):
      toxic_mode off, low vol  → positive  (score ≈ +0.3 to +0.6)
      toxic_mode off, high vol → neutral   (score ≈ -0.2 to +0.2)
      toxic_mode on            → negative  (score ≈ -0.5 to -0.8)
    """
    await ws.accept()
    _state.sentiment_clients.append(ws)
    score_ewma = 0.0
    prev_score = 0.0
    try:
        while True:
            # Derive target score from current mock state
            if _state.toxic_mode:
                target = random.uniform(-0.8, -0.4)
            elif _state.volatility > 0.001:
                target = random.uniform(-0.25, 0.25)
            else:
                target = random.uniform(0.2, 0.65)

            score_ewma = score_ewma * 0.7 + target * 0.3
            score      = round(max(-1.0, min(1.0, score_ewma + random.gauss(0, 0.05))), 4)
            momentum   = round(max(-1.0, min(1.0, score - prev_score)), 4)
            prev_score = score

            payload = json.dumps({"score": score, "momentum": momentum, "timestamp": int(time.time() * 1000)})
            await ws.send_text(payload)
            await asyncio.sleep(2.0)
    except Exception:
        pass
    finally:
        try:
            _state.sentiment_clients.remove(ws)
        except ValueError:
            pass


@app.get("/mock/state")
async def get_state():
    return {
        "base_price":        _state.base_price,
        "volatility":        _state.volatility,
        "tick_interval_ms":  _state.tick_interval_ms,
        "toxic_mode":        _state.toxic_mode,
        "rate_limit_active": _state.rate_limit_active,
        "latency_jitter_ms": _state.latency_jitter_ms,
        "order_fill_mode":   _state.order_fill_mode,
        "binance_lag_ms":    _state.binance_lag_ms,
        "open_orders":       len(_state.open_orders),
        "ws_clients":        len(_state.ws_clients),
        "sentiment_clients": len(_state.sentiment_clients),
    }


# ── Helpers ────────────────────────────────────────────────────────────────

async def _jitter():
    if _state.latency_jitter_ms > 0:
        await asyncio.sleep(_state.latency_jitter_ms / 1000)


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ── CLI entry ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Mock VALR server")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=args.host, port=args.port)
