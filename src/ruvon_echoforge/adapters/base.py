"""Abstract exchange adapter interface."""

from abc import ABC, abstractmethod
from typing import AsyncIterator, Callable, Awaitable


class ExchangeAdapter(ABC):
    """
    Isolates exchange-specific quirks from the EchoForge execution layer.
    Each adapter handles its own connection lifecycle, rate limiting, and parsing.
    """

    @abstractmethod
    async def connect(self) -> None:
        """Open WebSocket connection and authenticate."""

    @abstractmethod
    async def disconnect(self) -> None:
        """Gracefully close connection."""

    @abstractmethod
    def tick_stream(self) -> AsyncIterator[dict]:
        """
        Async generator yielding normalised tick dicts:
            {"symbol", "price", "volume", "side", "buy_volume", "sell_volume", "timestamp"}
        """

    @abstractmethod
    def orderbook_stream(self) -> AsyncIterator[dict]:
        """
        Async generator yielding normalised orderbook events:
            {"type": "snapshot"|"delta", "symbol", "bids": [[p,q],...], "asks": [[p,q],...], "timestamp"}
        """

    @abstractmethod
    async def submit_order(self, order: dict) -> dict:
        """
        Submit an order. Returns exchange response dict with at least {"order_id", "status"}.
        Raises on rejection or rate limit.
        """

    @abstractmethod
    async def cancel_all_orders(self, symbol: str) -> int:
        """Cancel all resting orders for symbol. Returns count cancelled."""

    @abstractmethod
    async def get_latency_ms(self) -> float:
        """Round-trip ping to exchange. Used by Proprioceptor."""
