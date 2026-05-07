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
    # Profit banking — two-tier velocity-aware system
    bank_profit_threshold_pct: float = Field(default=0.002, ge=0.0, le=0.10)  # 0.2% triggers tier-1
    bank_tier1_frac: float = Field(default=0.60, ge=0.1, le=1.0)              # 60% banked immediately
    bank_profit_dwell_min: int = Field(default=10, ge=1, le=60)               # fallback for tier-2
    # AI Jury — hardware-aware inference fidelity
    inference_fidelity: float = Field(default=0.5, ge=0.0, le=1.0)   # 0=single worker, 1=max jury
    # Advanced calibration (written by PHIC calibration wizard)
    vpin_crisis_threshold: float = Field(default=0.70, ge=0.0, le=1.0)
    vpin_highvol_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    regime_strain_exp: dict[str, float] = Field(
        default_factory=lambda: {"LowVol": 0.0, "HighVol": 0.5, "Crisis": 1.5}
    )
    # Guardian Worker governance
    guardian_mode: str = Field(default="shadow")           # "shadow" | "active"
    jury_entropy_threshold: float = Field(default=0.15, ge=0.0, le=1.0)
    mesh_heat_threshold: float = Field(default=0.80, ge=0.0, le=1.0)
    house_money_threshold: float = Field(default=100.0, ge=0.0)  # $ banked before risk-off
    house_lock_frac: float = Field(default=0.50, ge=0.0, le=1.0)
    rolling_sharpe_floor: float = Field(default=-0.5)
    # Calibration safety + strain protection
    max_crisis_threshold: float = Field(default=0.90, ge=0.50, le=1.0)   # hard ceiling on calibrated VPIN crisis
    strain_nack_threshold: float = Field(default=0.60, ge=0.0, le=1.0)   # strain ratio above which Guardian NACKs
    strain_cooldown_min: int = Field(default=5, ge=1, le=30)              # minutes to NACK pattern after strain breach
    vpin_recovery_min: int = Field(default=3, ge=1, le=15)                # minutes VPIN below HighVol before full size
    # Network / latency tuning
    latency_passive_ceiling_ms: float = Field(default=150.0, ge=50.0, le=500.0)  # above → FORCE_PASSIVE
    clock_skew_ceiling_ms: float = Field(default=50.0, ge=10.0, le=200.0)        # clock skew above → FORCE_PASSIVE
    halted_latency_ms: float = Field(default=500.0, ge=100.0, le=2000.0)         # above → Guardian HALTED
    execution_disabled: bool = False


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
