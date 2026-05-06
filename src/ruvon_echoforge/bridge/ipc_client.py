"""
DaemonIPCClient — async WebSocket client that connects to the Bun daemon's IPC
server at ws://localhost:{ECHOFORGE_IPC_PORT} (default 8767).

Responsibilities:
  - Receive vpin_update / ofi_update / heartbeat messages from the daemon
  - Feed observations to RegimeDetector
  - Push phic_update back to the daemon when regime transitions or OFI bias changes
  - Auto-reconnect with exponential back-off (5s → 30s max)

The RegimeDetector's on_transition callback fires on the calling thread (the
executor that ran _baum_welch). It calls asyncio.run_coroutine_threadsafe to
safely schedule _push_regime_change back on the event loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

logger = logging.getLogger(__name__)

_RECONNECT_BASE_S = 5
_RECONNECT_MAX_S  = 30


class DaemonIPCClient:
    def __init__(self, regime_detector) -> None:
        self._detector  = regime_detector
        self._ws        = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._running   = False
        self._last_ofi  = 0.0
        self._ofi_bias  = 0.0
        self.last_known_regime: str = "LowVol"

        # Wire regime transition callback (called from executor thread)
        self._detector.on_transition = self._on_regime_transition_threadsafe

    # ── Public ────────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._loop    = asyncio.get_running_loop()
        self._running = True
        asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            await self._ws.close()

    async def send(self, msg: dict) -> None:
        if self._ws is None:
            return
        try:
            await self._ws.send(json.dumps(msg))
        except Exception as exc:
            logger.debug("IPC send failed: %s", exc)

    # ── Internal ─────────────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        import websockets  # type: ignore[import]

        host = "127.0.0.1"
        port = int(os.getenv("ECHOFORGE_IPC_PORT", "8767"))
        url  = f"ws://{host}:{port}"
        delay = _RECONNECT_BASE_S

        while self._running:
            try:
                logger.info("IPC client connecting to %s", url)
                async with websockets.connect(url, ping_interval=20, ping_timeout=10) as ws:
                    self._ws = ws
                    delay    = _RECONNECT_BASE_S  # reset back-off on successful connect
                    logger.info("IPC client connected to daemon at %s", url)
                    await self._recv_loop(ws)
            except Exception as exc:
                logger.warning("IPC client disconnected: %s — retry in %ds", exc, delay)
                self._ws = None
                if self._running:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, _RECONNECT_MAX_S)

    async def _recv_loop(self, ws) -> None:
        async for raw in ws:
            if not self._running:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            await self._dispatch(msg)

    async def _dispatch(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "vpin_update":
            vpin       = float(msg.get("vpin",        0.0))
            latency_ms = float(msg.get("latency_ms",  10.0))
            momentum   = float(msg.get("momentum",    0.0))
            self._detector.record_observation(vpin, latency_ms, momentum)

        elif t == "ofi_update":
            bias = float(msg.get("ofi_bias", 0.0))
            self._ofi_bias = bias
            # Push proactive_overrides update if bias moved significantly (>0.1 delta)
            if abs(bias - self._last_ofi) > 0.1 and self._detector.is_warm:
                self._last_ofi = bias
                await self.send({
                    "type": "phic_update",
                    "config": {
                        "proactive_overrides": {
                            "ofi_bias": round(bias, 4),
                        }
                    },
                })

        elif t == "heartbeat":
            logger.debug("Daemon heartbeat: workers=%s uptime_ms=%s",
                         msg.get("workers_active"), msg.get("uptime_ms"))

    async def _push_regime_change(self, regime_tag: str, confidence: float) -> None:
        """Push HMM regime update + risk_multiplier to all daemon workers."""
        from .regime import RISK_BY_REGIME

        self.last_known_regime = regime_tag
        risk = RISK_BY_REGIME.get(regime_tag, 1.0)
        await self.send({
            "type":   "regime_change",
            "regime_tag": regime_tag,
        })
        await self.send({
            "type": "phic_update",
            "config": {
                "proactive_overrides": {
                    "regime_forecast":  regime_tag,
                    "risk_multiplier":  risk,
                    "hmm_confidence":   round(confidence, 4),
                },
            },
        })
        logger.info("IPC: pushed regime_change %s (conf=%.2f, risk=%.1f)", regime_tag, confidence, risk)

    def _on_regime_transition_threadsafe(self, regime_tag: str, confidence: float) -> None:
        """Called from executor thread — schedules the push on the event loop."""
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(
                self._push_regime_change(regime_tag, confidence),
                self._loop,
            )
