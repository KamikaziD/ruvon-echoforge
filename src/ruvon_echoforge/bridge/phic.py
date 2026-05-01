"""PHIC governance API — human sets strategic bounds, system executes within them."""

import hashlib
import json
import logging
import os
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(tags=["phic"])


class PHICConfig(BaseModel):
    # Core
    autonomy_level: float = Field(default=0.5, ge=0.0, le=1.0)
    vetoed_patterns: list[str] = Field(default_factory=list)
    regime_caps: dict[str, float] = Field(default_factory=dict)
    emergency_freeze: bool = False
    # Position sizing
    max_position_pct: float = Field(default=1.0, ge=0.0, le=100.0)
    max_total_exposure_pct: float = Field(default=20.0, ge=0.0, le=100.0)
    max_pattern_exposure_pct: float = Field(default=0.30, ge=0.0, le=1.0)
    # Risk controls
    stop_loss_pct: float = Field(default=2.5, ge=0.0, le=10.0)
    max_drawdown_pct: float = Field(default=2.0, ge=0.0, le=100.0)
    drawdown_hysteresis_n: int = Field(default=3, ge=1, le=10)
    # Correlation controls
    correlation_enabled: bool = True
    rvr_threshold: float = Field(default=1.5, ge=0.5, le=3.0)
    pearson_threshold: float = Field(default=0.5, ge=0.1, le=0.9)
    cross_pair_boost: float = Field(default=0.04, ge=0.0, le=0.10)
    # Consensus
    min_consensus_pct: float = Field(default=60.0, ge=0.0, le=100.0)
    # Advanced calibration (written by PHIC calibration wizard)
    vpin_crisis_threshold: float = Field(default=0.70, ge=0.0, le=1.0)
    vpin_highvol_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    regime_strain_exp: dict[str, float] = Field(
        default_factory=lambda: {"LowVol": 0.0, "HighVol": 0.5, "Crisis": 1.5}
    )


class PHICState:
    def __init__(self):
        self._config = PHICConfig()
        self._subscribers: list[Any] = []

    @property
    def config(self) -> PHICConfig:
        return self._config

    def update(self, new_config: PHICConfig) -> str:
        self._config = new_config
        fingerprint = hashlib.md5(
            new_config.model_dump_json().encode()
        ).hexdigest()[:8]
        return fingerprint

    def subscribe(self, ws) -> None:
        self._subscribers.append(ws)

    def unsubscribe(self, ws) -> None:
        self._subscribers.discard(ws) if hasattr(self._subscribers, "discard") else None
        try:
            self._subscribers.remove(ws)
        except ValueError:
            pass

    async def broadcast(self, config: PHICConfig, config_hash: str) -> None:
        payload = json.dumps({
            "type": "phic_update",
            "config": config.model_dump(),
            "config_hash": config_hash,
        })
        dead = []
        for ws in self._subscribers:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(ws)


# Singleton shared across bridge
phic_state = PHICState()


@router.get("/phic/config", response_model=PHICConfig)
async def get_phic_config():
    return phic_state.config


@router.post("/phic/config")
async def update_phic_config(config: PHICConfig):
    config_hash = phic_state.update(config)
    await phic_state.broadcast(config, config_hash)

    # Optional: publish to NATS if available
    nats_url = os.getenv("NATS_URL")
    if nats_url:
        try:
            import nats
            nc = await nats.connect(nats_url)
            await nc.publish(
                "echoforge.phic.config",
                json.dumps({"config": config.model_dump(), "hash": config_hash}).encode(),
            )
            await nc.drain()
        except Exception as exc:
            logger.warning("NATS publish failed (non-fatal): %s", exc)

    return {"status": "applied", "config_hash": config_hash}


@router.websocket("/phic/ws")
async def phic_ws(ws: WebSocket):
    """Dashboard subscribes here to receive live PHIC config pushes."""
    await ws.accept()
    phic_state.subscribe(ws)
    # Send current config immediately on connect
    try:
        await ws.send_text(json.dumps({
            "type": "phic_update",
            "config": phic_state.config.model_dump(),
        }))
        while True:
            # Keep alive — client sends nothing; we push on config changes via broadcast
            try:
                await ws.receive_text()
            except WebSocketDisconnect:
                break
    finally:
        phic_state.unsubscribe(ws)


@router.post("/phic/freeze")
async def emergency_freeze():
    frozen = phic_state.config.model_copy(update={"emergency_freeze": True})
    config_hash = phic_state.update(frozen)
    await phic_state.broadcast(frozen, config_hash)
    logger.warning("EMERGENCY FREEZE activated")
    return {"status": "frozen", "config_hash": config_hash}
