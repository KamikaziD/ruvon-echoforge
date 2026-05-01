"""EchoForge engine — pattern registry, sentinel dispatch, aliveness management."""

import asyncio
import logging
import time
from collections import deque
from typing import Any

from .decay import MarketEcho

logger = logging.getLogger(__name__)

# VPIN toxicity threshold (Nociceptor)
VPIN_THRESHOLD = 0.70
# Proprioceptor latency ceiling (ms)
LATENCY_CEILING_MS = 150.0
# Clock skew ceiling (ms)
CLOCK_SKEW_MS = 50.0
# Metabolic hurdle multiplier (regime-adjusted)
HURDLE_MULTIPLIER = 1.0

# Rolling window for VPIN calculation (tick count)
VPIN_WINDOW = 50


class EchoForgeEngine:
    """
    Server-side EchoForge engine.

    In the full architecture, sentinels run in browser Wasm workers.
    This server-side engine provides the same logic for non-browser nodes
    and acts as the authoritative aliveness store.
    """

    def __init__(self):
        self._echoes: dict[str, MarketEcho] = {}
        self._tick_window: deque[dict] = deque(maxlen=VPIN_WINDOW)
        self._latency_ewma: float = 10.0     # ms EWMA
        self._clock_skew: float = 0.0
        self._passive_only: bool = False
        self._last_received_at: float = time.time()

    # ------------------------------------------------------------------
    # Tick processing (Nociceptor + Metabolic in one pass)
    # ------------------------------------------------------------------

    async def process_tick(self, tick: dict) -> list[dict]:
        """Process one market tick. Returns list of sentinel alert dicts (may be empty)."""
        alerts: list[dict] = []
        now_ms = int(time.time() * 1000)

        # Track arrival latency via timestamp in tick
        tick_ts = tick.get("timestamp", now_ms)
        if isinstance(tick_ts, (int, float)):
            latency = now_ms - tick_ts
            self._latency_ewma = self._latency_ewma * 0.9 + latency * 0.1

        self._tick_window.append(tick)

        # --- Nociceptor ---
        vpin = self._compute_vpin()
        if vpin > VPIN_THRESHOLD:
            alerts.append({
                "sentinel_type": "Nociceptor",
                "action": "CANCEL_ORDERS",
                "severity": round(min(vpin, 1.0), 3),
                "detail": f"VPIN={vpin:.3f} > threshold={VPIN_THRESHOLD}",
                "timestamp": now_ms,
            })
            logger.warning("Nociceptor: toxic flow detected VPIN=%.3f", vpin)

        # --- Proprioceptor ---
        if self._latency_ewma > LATENCY_CEILING_MS:
            if not self._passive_only:
                self._passive_only = True
                alerts.append({
                    "sentinel_type": "Proprioceptor",
                    "action": "FORCE_PASSIVE",
                    "severity": round(min(self._latency_ewma / 300.0, 1.0), 3),
                    "detail": f"EWMA latency={self._latency_ewma:.1f}ms > {LATENCY_CEILING_MS}ms",
                    "timestamp": now_ms,
                })
        elif self._passive_only and self._latency_ewma < LATENCY_CEILING_MS * 0.7:
            self._passive_only = False  # recovered

        return alerts

    # ------------------------------------------------------------------
    # Metabolic filter — called before any execution intent
    # ------------------------------------------------------------------

    def passes_metabolic(
        self,
        pattern_id: str,
        gross_delta: float,
        maker_fee: float,
        taker_fee: float,
        slippage: float,
        regime_multiplier: float = 1.0,
    ) -> tuple[bool, dict]:
        net_alpha = gross_delta - (maker_fee + taker_fee + slippage)
        hurdle = (maker_fee + taker_fee) * HURDLE_MULTIPLIER * regime_multiplier
        passes = net_alpha >= hurdle and not self._passive_only
        return passes, {
            "pattern_id": pattern_id,
            "gross_delta": gross_delta,
            "net_alpha": round(net_alpha, 6),
            "hurdle": round(hurdle, 6),
            "passes": passes,
            "passive_only": self._passive_only,
        }

    # ------------------------------------------------------------------
    # EchoForge memory management
    # ------------------------------------------------------------------

    def get_or_create_echo(self, pattern_id: str, regime_tag: str = "LowVol") -> MarketEcho:
        if pattern_id not in self._echoes:
            self._echoes[pattern_id] = MarketEcho(pattern_id=pattern_id, regime_tag=regime_tag)
        return self._echoes[pattern_id]

    async def record_outcome(self, pattern_id: str, outcome_score: float) -> dict | None:
        """Update echo aliveness after execution. Returns updated shared dict."""
        echo = self._echoes.get(pattern_id)
        if echo is None:
            return None
        echo.update(outcome_score)
        logger.debug(
            "Echo %s updated: aliveness=%.3f (outcome=%.2f)",
            pattern_id, echo.net_aliveness, outcome_score,
        )
        return echo.as_full_dict()

    def apply_peer_echo(self, shared: dict) -> None:
        """Merge a gossip SharedEcho from a peer node (weighted average)."""
        pid = shared.get("pattern_id")
        if not pid:
            return
        peer_aliveness = float(shared.get("net_aliveness", 0.5))
        peer_decay = float(shared.get("decay_rate", 0.1))
        regime = shared.get("regime_tag", "LowVol")

        echo = self.get_or_create_echo(pid, regime)
        # Soft merge: weight local 70%, peer 30%
        echo.net_aliveness = echo.net_aliveness * 0.7 + peer_aliveness * 0.3
        echo.decay_rate = echo.decay_rate * 0.8 + peer_decay * 0.2
        echo.regime_tag = regime

    def get_all_echoes(self) -> list[dict]:
        return [e.as_full_dict() for e in self._echoes.values()]

    def get_alive_echoes(self, min_aliveness: float = 0.3) -> list[dict]:
        return [
            e.as_full_dict()
            for e in self._echoes.values()
            if e.net_aliveness >= min_aliveness
        ]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _compute_vpin(self) -> float:
        if len(self._tick_window) < 2:
            return 0.0
        buy_vol = sum(t.get("buy_volume", 0.0) for t in self._tick_window)
        sell_vol = sum(t.get("sell_volume", 0.0) for t in self._tick_window)
        total = buy_vol + sell_vol
        if total == 0:
            return 0.0
        return abs(buy_vol - sell_vol) / total

    @property
    def current_vpin(self) -> float:
        return self._compute_vpin()

    @property
    def latency_ewma_ms(self) -> float:
        return self._latency_ewma

    @property
    def is_passive_only(self) -> bool:
        return self._passive_only
