"""VALR exchange adapter — WebSocket L2 feed + REST order submission."""

import asyncio
import hashlib
import hmac
import json
import logging
import time
from typing import AsyncIterator

import websockets
import httpx

from .base import ExchangeAdapter

logger = logging.getLogger(__name__)

# VALR REST base — can be overridden for mock server
VALR_REST_BASE = "https://api.valr.com"
VALR_WS_BASE   = "wss://api.valr.com"


class VALRAdapter(ExchangeAdapter):
    """
    VALR exchange adapter.

    Handles:
      - HMAC-SHA512 request signing (API key + secret)
      - WebSocket MARKET_SUMMARY_UPDATE + AGGREGATED_ORDERBOOK_UPDATE streams
      - Normalised tick/orderbook output for EchoForge workers
      - Rate-limit detection (429 → backoff)

    Set `rest_base` / `ws_base` to point at the mock server during testing.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        symbol: str = "BTCUSDT",
        rest_base: str = VALR_REST_BASE,
        ws_base: str = VALR_WS_BASE,
    ):
        self._key    = api_key
        self._secret = api_secret
        self._symbol = symbol
        self._rest   = rest_base.rstrip("/")
        self._ws_url = ws_base.rstrip("/")
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._http   = httpx.AsyncClient(timeout=10.0)
        self._rate_limit_until: float = 0.0

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def connect(self) -> None:
        url = f"{self._ws_url}/v1/ws"
        self._ws = await websockets.connect(url, extra_headers=self._ws_auth_headers())
        logger.info("VALR WebSocket connected: %s", url)
        # Subscribe to account + market streams
        await self._ws.send(json.dumps({
            "type":     "SUBSCRIBE",
            "subscriptions": [
                {"event": "AGGREGATED_ORDERBOOK_UPDATE", "pairs": [self._symbol]},
                {"event": "MARKET_SUMMARY_UPDATE",       "pairs": [self._symbol]},
                {"event": "NEW_TRADE",                   "pairs": [self._symbol]},
            ],
        }))

    async def disconnect(self) -> None:
        if self._ws:
            await self._ws.close()
        await self._http.aclose()

    # ── Streams ──────────────────────────────────────────────────────────────

    async def tick_stream(self) -> AsyncIterator[dict]:
        """Yields normalised trade ticks from NEW_TRADE events."""
        async for raw in self._recv_loop():
            if raw.get("type") != "NEW_TRADE":
                continue
            data = raw.get("data", {})
            price  = float(data.get("price", 0))
            qty    = float(data.get("quantity", 0))
            side   = "buy" if data.get("takerSide", "").lower() == "buy" else "sell"
            ts     = data.get("tradedAt", "")
            ts_ms  = _iso_to_ms(ts) if ts else int(time.time() * 1000)
            yield {
                "symbol":      self._symbol,
                "price":       price,
                "volume":      qty,
                "side":        side,
                "buy_volume":  qty if side == "buy"  else 0.0,
                "sell_volume": qty if side == "sell" else 0.0,
                "timestamp":   ts_ms,
                "exchange":    "VALR",
            }

    async def orderbook_stream(self) -> AsyncIterator[dict]:
        """Yields normalised orderbook snapshots from AGGREGATED_ORDERBOOK_UPDATE."""
        async for raw in self._recv_loop():
            if raw.get("type") != "AGGREGATED_ORDERBOOK_UPDATE":
                continue
            data  = raw.get("data", {})
            bids  = [[float(b["price"]), float(b["quantity"])] for b in data.get("Bids", [])]
            asks  = [[float(a["price"]), float(a["quantity"])] for a in data.get("Asks", [])]
            ts_ms = _iso_to_ms(data.get("LastChange", "")) or int(time.time() * 1000)
            yield {
                "type":      "snapshot",
                "symbol":    self._symbol,
                "bids":      bids,
                "asks":      asks,
                "timestamp": ts_ms,
                "exchange":  "VALR",
            }

    # ── Order management ─────────────────────────────────────────────────────

    async def submit_order(self, order: dict) -> dict:
        if time.time() < self._rate_limit_until:
            raise RuntimeError(f"Rate limited until {self._rate_limit_until:.0f}")

        payload = {
            "side":          "BUY" if order.get("side") == "buy" else "SELL",
            "quantity":      str(order.get("quantity", 0)),
            "pair":          self._symbol,
            "postOnly":      False,
            "reduceOnly":    False,
            "timeInForce":   order.get("time_in_force", "IOC"),
        }
        if order.get("limit_price", 0) > 0:
            payload["price"] = str(order["limit_price"])
            endpoint = f"/v1/orders/limit"
        else:
            endpoint = f"/v1/orders/market"

        resp = await self._signed_post(endpoint, payload)

        if resp.status_code == 429:
            retry = int(resp.headers.get("Retry-After", 5))
            self._rate_limit_until = time.time() + retry
            raise RuntimeError(f"VALR rate limited: retry after {retry}s")

        if resp.status_code not in (200, 202):
            raise RuntimeError(f"VALR order rejected {resp.status_code}: {resp.text}")

        data = resp.json()
        return {"order_id": data.get("id", ""), "status": "submitted", "raw": data}

    async def cancel_all_orders(self, symbol: str) -> int:
        resp = await self._signed_delete(f"/v1/orders/{symbol}")
        if resp.status_code not in (200, 204):
            logger.warning("VALR cancel_all failed: %s", resp.text)
            return 0
        return 1  # VALR doesn't return count; assume success

    async def get_latency_ms(self) -> float:
        t0   = time.perf_counter()
        resp = await self._http.get(f"{self._rest}/v1/public/time")
        return (time.perf_counter() - t0) * 1000

    # ── Internal ─────────────────────────────────────────────────────────────

    async def _recv_loop(self):
        while True:
            if not self._ws or self._ws.closed:
                await asyncio.sleep(1)
                continue
            try:
                raw = await self._ws.recv()
                yield json.loads(raw)
            except websockets.exceptions.ConnectionClosed:
                logger.warning("VALR WebSocket closed; reconnecting in 3s")
                await asyncio.sleep(3)
                await self.connect()

    def _ws_auth_headers(self) -> dict:
        ts    = str(int(time.time() * 1000))
        verb  = "GET"
        path  = "/v1/ws"
        body  = ""
        sig   = self._sign(ts, verb, path, body)
        return {
            "X-VALR-API-KEY":       self._key,
            "X-VALR-SIGNATURE":     sig,
            "X-VALR-TIMESTAMP":     ts,
        }

    def _sign(self, timestamp: str, verb: str, path: str, body: str = "") -> str:
        payload = timestamp + verb.upper() + path + body
        return hmac.new(
            self._secret.encode(), payload.encode(), hashlib.sha512
        ).hexdigest()

    async def _signed_post(self, path: str, data: dict) -> httpx.Response:
        body  = json.dumps(data)
        ts    = str(int(time.time() * 1000))
        sig   = self._sign(ts, "POST", path, body)
        return await self._http.post(
            self._rest + path,
            content=body,
            headers={
                "Content-Type":     "application/json",
                "X-VALR-API-KEY":   self._key,
                "X-VALR-SIGNATURE": sig,
                "X-VALR-TIMESTAMP": ts,
            },
        )

    async def _signed_delete(self, path: str) -> httpx.Response:
        ts  = str(int(time.time() * 1000))
        sig = self._sign(ts, "DELETE", path)
        return await self._http.delete(
            self._rest + path,
            headers={
                "X-VALR-API-KEY":   self._key,
                "X-VALR-SIGNATURE": sig,
                "X-VALR-TIMESTAMP": ts,
            },
        )


def _iso_to_ms(iso: str) -> int:
    """Convert ISO-8601 string to Unix milliseconds."""
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(iso.rstrip("Z")).replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)
