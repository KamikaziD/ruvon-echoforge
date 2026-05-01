"""Binance exchange adapter — WebSocket depth + aggTrade streams + REST orders."""

import asyncio
import hashlib
import hmac
import json
import logging
import time
import urllib.parse
from typing import AsyncIterator

import websockets
import httpx

from .base import ExchangeAdapter

logger = logging.getLogger(__name__)

BINANCE_REST_BASE = "https://api.binance.com"
BINANCE_WS_BASE   = "wss://stream.binance.com:9443"


class BinanceAdapter(ExchangeAdapter):
    """
    Binance spot adapter.

    Uses combined stream endpoint for low-latency tick + depth data.
    Normalises output to the same schema as VALRAdapter so the execution
    worker is exchange-agnostic.

    Set `rest_base` / `ws_base` to point at a mock server during testing.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        symbol: str = "BTCUSDT",
        rest_base: str = BINANCE_REST_BASE,
        ws_base: str = BINANCE_WS_BASE,
    ):
        self._key    = api_key
        self._secret = api_secret
        self._symbol = symbol.lower()          # Binance streams use lowercase
        self._sym_upper = symbol.upper()
        self._rest   = rest_base.rstrip("/")
        self._ws_url = ws_base.rstrip("/")
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._http   = httpx.AsyncClient(timeout=10.0)
        self._rate_limit_until: float = 0.0
        self._msg_queue: asyncio.Queue = asyncio.Queue(maxsize=2048)

    async def connect(self) -> None:
        streams = f"{self._symbol}@aggTrade/{self._symbol}@depth20@100ms"
        url = f"{self._ws_url}/stream?streams={streams}"
        self._ws = await websockets.connect(url)
        logger.info("Binance WebSocket connected: %s", url)
        asyncio.create_task(self._pump())

    async def disconnect(self) -> None:
        if self._ws:
            await self._ws.close()
        await self._http.aclose()

    async def tick_stream(self) -> AsyncIterator[dict]:
        """Yields normalised ticks from aggTrade stream."""
        async for raw in self._stream_filter("aggTrade"):
            price = float(raw.get("p", 0))
            qty   = float(raw.get("q", 0))
            side  = "sell" if raw.get("m") else "buy"   # m=true means buyer is maker → sell aggressor
            ts_ms = int(raw.get("T", time.time() * 1000))
            yield {
                "symbol":      self._sym_upper,
                "price":       price,
                "volume":      qty,
                "side":        side,
                "buy_volume":  qty if side == "buy"  else 0.0,
                "sell_volume": qty if side == "sell" else 0.0,
                "timestamp":   ts_ms,
                "exchange":    "BINANCE",
            }

    async def orderbook_stream(self) -> AsyncIterator[dict]:
        """Yields normalised orderbook snapshots from depth20 stream."""
        async for raw in self._stream_filter("depth20"):
            bids = [[float(b[0]), float(b[1])] for b in raw.get("bids", [])]
            asks = [[float(a[0]), float(a[1])] for a in raw.get("asks", [])]
            yield {
                "type":      "snapshot",
                "symbol":    self._sym_upper,
                "bids":      bids,
                "asks":      asks,
                "timestamp": int(time.time() * 1000),
                "exchange":  "BINANCE",
            }

    async def submit_order(self, order: dict) -> dict:
        if time.time() < self._rate_limit_until:
            raise RuntimeError("Binance rate limited")

        params: dict = {
            "symbol":      self._sym_upper,
            "side":        "BUY" if order.get("side") == "buy" else "SELL",
            "type":        "MARKET" if not order.get("limit_price") else "LIMIT",
            "quantity":    f"{order.get('quantity', 0):.8f}",
            "timestamp":   int(time.time() * 1000),
            "recvWindow":  5000,
        }
        if params["type"] == "LIMIT":
            params["price"]       = f"{order['limit_price']:.2f}"
            params["timeInForce"] = order.get("time_in_force", "IOC")

        params["signature"] = self._sign(urllib.parse.urlencode(params))
        resp = await self._http.post(
            f"{self._rest}/api/v3/order",
            params=params,
            headers={"X-MBX-APIKEY": self._key},
        )

        if resp.status_code == 429:
            self._rate_limit_until = time.time() + 60
            raise RuntimeError("Binance rate limited")
        if resp.status_code != 200:
            raise RuntimeError(f"Binance order failed {resp.status_code}: {resp.text}")

        data = resp.json()
        return {"order_id": str(data.get("orderId", "")), "status": data.get("status", ""), "raw": data}

    async def cancel_all_orders(self, symbol: str) -> int:
        ts   = int(time.time() * 1000)
        q    = f"symbol={symbol.upper()}&timestamp={ts}"
        sig  = self._sign(q)
        resp = await self._http.delete(
            f"{self._rest}/api/v3/openOrders",
            params={"symbol": symbol.upper(), "timestamp": ts, "signature": sig},
            headers={"X-MBX-APIKEY": self._key},
        )
        if resp.status_code != 200:
            return 0
        return len(resp.json())

    async def get_latency_ms(self) -> float:
        t0   = time.perf_counter()
        await self._http.get(f"{self._rest}/api/v3/ping")
        return (time.perf_counter() - t0) * 1000

    # ── Internal ─────────────────────────────────────────────────────────────

    async def _pump(self):
        """Background task: receive WS messages and push to queue."""
        while True:
            if not self._ws or self._ws.closed:
                await asyncio.sleep(1)
                continue
            try:
                raw = await self._ws.recv()
                msg = json.loads(raw)
                await self._msg_queue.put(msg)
            except websockets.exceptions.ConnectionClosed:
                logger.warning("Binance WS closed; reconnecting in 3s")
                await asyncio.sleep(3)
                await self.connect()
            except Exception as exc:
                logger.debug("Binance pump error: %s", exc)

    async def _stream_filter(self, stream_suffix: str):
        """Yield data payloads whose stream name ends with stream_suffix."""
        while True:
            envelope = await self._msg_queue.get()
            stream   = envelope.get("stream", "")
            if stream_suffix in stream:
                yield envelope.get("data", envelope)

    def _sign(self, query_string: str) -> str:
        return hmac.new(
            self._secret.encode(), query_string.encode(), hashlib.sha256
        ).hexdigest()
