"""PHIC governance API — human sets strategic bounds, system executes within them."""

import hashlib
import json
import logging
import os
from typing import Any

import yaml
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(tags=["phic"])


class PHICConfig(BaseModel):
    # Core
    autonomy_level: float = Field(default=0.85, ge=0.0, le=1.0)
    vetoed_patterns: list[str] = Field(default_factory=list)
    regime_caps: dict[str, float] = Field(default_factory=lambda: {"LowVol": 0.8, "HighVol": 1.0, "Crisis": 0.0})
    hurdle_regime_scale: dict[str, float] = Field(default_factory=lambda: {"LowVol": 0.70, "HighVol": 0.95, "Crisis": 1.75})
    emergency_freeze: bool = False
    # Position sizing
    max_position_pct: float = Field(default=15.0, ge=0.0, le=100.0)
    max_total_exposure_pct: float = Field(default=0.20, ge=0.0, le=1.0)
    max_pattern_exposure_pct: float = Field(default=0.10, ge=0.0, le=1.0)
    # Risk controls
    stop_loss_pct: float = Field(default=2.0, ge=0.0, le=10.0)
    stop_loss_sell_frac: float = Field(default=0.45, ge=0.0, le=1.0)
    stop_loss_buy_freeze_ms: int = Field(default=600_000, ge=0)
    cap_trim_buy_freeze_ms: int = Field(default=180_000, ge=0)
    post_crisis_buy_freeze_ms: int = Field(default=300_000, ge=0)   # freeze buys after crisis VPIN spike
    session_start_warmup_min: int = Field(default=3, ge=0, le=30)   # size-scale new sessions for N min
    stop_loss_reentry_buffer: float = Field(default=0.010, ge=0.0, le=0.10)
    kelly_payoff_ratio: float = Field(default=1.5, ge=1.0, le=5.0)
    max_drawdown_pct: float = Field(default=8.0, ge=0.0, le=100.0)
    drawdown_hysteresis_n: int = Field(default=3, ge=1, le=10)
    # Correlation controls
    correlation_enabled: bool = True
    rvr_threshold: float = Field(default=1.2, ge=0.5, le=3.0)
    pearson_threshold: float = Field(default=0.45, ge=0.1, le=0.9)
    cross_pair_boost: float = Field(default=0.04, ge=0.0, le=0.10)
    # Consensus
    min_consensus_pct: float = Field(default=60.0, ge=0.0, le=100.0)
    # Profit banking
    bank_profit_threshold_pct: float = Field(default=0.012, ge=0.0, le=0.10)
    bank_tier1_frac: float = Field(default=0.60, ge=0.1, le=1.0)
    bank_profit_dwell_min: int = Field(default=4, ge=1, le=60)
    bank_extract_enabled: bool = Field(default=True)   # submit real BANK_EXTRACT sell; False = paper counter only
    # AI Jury
    inference_fidelity: float = Field(default=0.70, ge=0.0, le=1.0)
    # VPIN tuning
    vpin_crisis_threshold: float = Field(default=0.85, ge=0.0, le=1.0)
    vpin_highvol_threshold: float = Field(default=0.50, ge=0.0, le=1.0)
    vpin_hysteresis: float = Field(default=0.08, ge=0.0, le=0.20)
    vpin_ewma_alpha: float = Field(default=0.02, ge=0.001, le=0.10)
    regime_dwell_min: int = Field(default=5, ge=0, le=15)
    # Regime strain
    regime_strain_exp: dict[str, float] = Field(
        default_factory=lambda: {"LowVol": 0.0, "HighVol": 0.5, "Crisis": 1.5}
    )
    # Guardian Worker governance
    guardian_mode: str = Field(default="active")           # "shadow" | "active"
    conflict_position_threshold: float = Field(default=0.25, ge=0.0, le=1.0)  # fill fraction below which sell-vs-buy conflict is ignored
    conflict_window_ms: int = Field(default=5_000, ge=500, le=60_000)
    direction_lock_ms: int = Field(default=15_000, ge=1_000, le=120_000)
    jury_entropy_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    mesh_heat_threshold: float = Field(default=0.80, ge=0.0, le=1.0)
    house_money_threshold: float = Field(default=100.0, ge=0.0)
    house_lock_frac: float = Field(default=0.50, ge=0.0, le=1.0)
    rolling_sharpe_floor: float = Field(default=-0.7)
    # Calibration safety
    max_crisis_threshold: float = Field(default=0.90, ge=0.50, le=1.0)
    strain_nack_threshold: float = Field(default=0.60, ge=0.0, le=1.0)
    strain_cooldown_min: int = Field(default=5, ge=1, le=30)
    vpin_recovery_min: int = Field(default=3, ge=1, le=15)
    reduce_only_lowvol_frac: float = Field(default=0.25, ge=0.0, le=1.0)
    reduce_only_flat_dwell_sec: int = Field(default=30, ge=0, le=300)  # seconds after BTC hits zero before exiting REDUCE_ONLY
    # Freeze recovery
    freeze_recovery_dwell_min: int = Field(default=15, ge=1, le=60)
    freeze_recovery_slip_pct: float = Field(default=1.0, ge=0.0, le=10.0)
    freeze_recovery_warmup_min: int = Field(default=10, ge=1, le=60)
    # SL circuit breaker
    sl_circuit_breaker_n: int = Field(default=2, ge=1, le=10)
    sl_circuit_breaker_window_min: int = Field(default=30, ge=5, le=120)
    # DCA guard
    dca_aliveness_floor: float = Field(default=0.80, ge=0.0, le=1.0)
    # Echo aliveness tuning
    signal_boost: float = Field(default=0.03, ge=0.0, le=0.20)
    paper_shadow_alpha: float = Field(default=0.10, ge=0.001, le=0.50)
    paper_min_trades: int = Field(default=4, ge=1, le=20)
    # Network / latency tuning
    latency_passive_ceiling_ms: float = Field(default=150.0, ge=50.0, le=500.0)
    clock_skew_ceiling_ms: float = Field(default=50.0, ge=10.0, le=200.0)
    halted_latency_ms: float = Field(default=500.0, ge=100.0, le=2000.0)
    auto_thaw_minutes: int = Field(default=5, ge=1, le=30)
    execution_disabled: bool = False
    # S(Ex) sovereign score weights
    s_ex_weight_latency: float = Field(default=0.50, ge=0.0, le=1.0)
    s_ex_weight_uptime: float = Field(default=0.25, ge=0.0, le=1.0)
    s_ex_weight_consensus: float = Field(default=0.15, ge=0.0, le=1.0)
    s_ex_weight_peers: float = Field(default=0.10, ge=0.0, le=1.0)
    # Per-strategy decay rates (regression optimizer)
    decay_rate_momentum: float | None = Field(default=None)
    decay_rate_mean_reversion: float | None = Field(default=None)
    decay_rate_maker: float | None = Field(default=None)
    decay_rate_trend: float | None = Field(default=None)
    decay_rate_institutional: float | None = Field(default=None)
    decay_rate_breakout: float | None = Field(default=None)
    decay_rate_arb: float | None = Field(default=None)
    # Regression optimizer meta
    regression_override: bool = False
    regression_last_applied_ms: int = 0
    # Macro regime governor
    macro_enabled: bool = True
    hurst_trending_threshold: float = Field(default=0.55, ge=0.0, le=1.0)
    hurst_reverting_threshold: float = Field(default=0.45, ge=0.0, le=1.0)
    hurst_window_min: int = Field(default=8, ge=1, le=120)
    cvd_lookback_min: int = Field(default=240, ge=30, le=1440)
    cvd_divergence_threshold: float = Field(default=0.15, ge=0.01, le=1.0)
    depth_thin_pct: float = Field(default=0.50, ge=0.0, le=1.0)
    depth_window_h: int = Field(default=24, ge=1, le=168)
    correlation_depeg_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    correlation_window_h: int = Field(default=1, ge=1, le=24)
    macro_kelly_thin_scale: float = Field(default=0.50, ge=0.0, le=1.0)
    # Vault Governor — proactive macro-triggered liquidation
    vault_enabled: bool = True
    vault_vpin_threshold: float = Field(default=0.85, ge=0.50, le=1.0)
    vault_cvd_trigger: bool = True
    vault_hurst_trigger: bool = True
    vault_depth_trigger: bool = True
    vault_vpin_trigger: bool = True
    vault_compromise_score: int = Field(default=3, ge=1, le=6)
    vault_dwell_min: int = Field(default=15, ge=1, le=120)
    vault_flat_dwell_min: int = Field(default=3, ge=1, le=30)      # dwell when position already flat
    # Drought re-entry guard — prevents correlated burst after long freeze
    drought_threshold_min: int = Field(default=5, ge=1, le=60)
    drought_reentry_size: float = Field(default=0.50, ge=0.10, le=1.0)


# ── Config loader ─────────────────────────────────────────────────────────────

def _load_yaml_presets() -> dict[str, Any]:
    """Load preset definitions from echoforge.config.yaml; return {} on failure."""
    config_path = os.getenv("ECHOFORGE_CONFIG", "echoforge.config.yaml")
    try:
        with open(config_path) as f:
            data = yaml.safe_load(f)
        return data.get("phic_presets", {}) if isinstance(data, dict) else {}
    except FileNotFoundError:
        logger.debug("echoforge.config.yaml not found at %r — using model defaults", config_path)
        return {}
    except Exception as exc:
        logger.warning("Failed to load %r: %s — using model defaults", config_path, exc)
        return {}


def _init_phic_from_env() -> PHICConfig:
    """Build initial PHICConfig: YAML preset → ECHOFORGE_PHIC_<FIELD> env overrides."""
    presets = _load_yaml_presets()
    preset_name = os.getenv("ECHOFORGE_PHIC_PRESET", "medium").lower()
    preset_entry = presets.get(preset_name, {})
    base: dict[str, Any] = dict(preset_entry.get("config", {})) if preset_entry else {}

    prefix = "ECHOFORGE_PHIC_"
    for key, raw in os.environ.items():
        if not key.startswith(prefix):
            continue
        field = key[len(prefix):].lower()
        if field not in PHICConfig.model_fields:
            continue
        try:
            base[field] = json.loads(raw)
        except json.JSONDecodeError:
            base[field] = raw  # plain string (e.g. guardian_mode="active")

    try:
        return PHICConfig(**base)
    except Exception as exc:
        logger.warning("PHICConfig init from preset %r failed (%s) — using model defaults", preset_name, exc)
        return PHICConfig()


# ── PHICState singleton ───────────────────────────────────────────────────────

class PHICState:
    def __init__(self):
        self._config = _init_phic_from_env()
        self._subscribers: list[Any] = []

    @property
    def config(self) -> PHICConfig:
        return self._config

    def update(self, new_config: PHICConfig) -> str:
        self._config = new_config
        return hashlib.md5(new_config.model_dump_json().encode()).hexdigest()[:8]

    def subscribe(self, ws) -> None:
        self._subscribers.append(ws)

    def unsubscribe(self, ws) -> None:
        try:
            self._subscribers.remove(ws)
        except ValueError:
            pass

    async def broadcast(self, config: PHICConfig, config_hash: str) -> None:
        # Late import avoids circular dependency at module load time
        from .metrics import broadcast_event

        payload = json.dumps({
            "type":        "phic_update",
            "config":      config.model_dump(),
            "config_hash": config_hash,
        })
        # Push to phic-WS subscribers (dashboard phic panel)
        dead = []
        for ws in self._subscribers:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(ws)
        # Also relay via metrics-WS so PHICClient (browser nodes) receives the update
        await broadcast_event({"type": "phic_update", "config": config.model_dump(), "config_hash": config_hash})


phic_state = PHICState()


# ── REST / WS endpoints ───────────────────────────────────────────────────────

@router.get("/phic/presets")
async def get_phic_presets():
    """All preset definitions from echoforge.config.yaml — consumed by dashboard and browser on connect."""
    presets = _load_yaml_presets()
    return {
        name: {
            "label":  entry.get("label", name),
            "hint":   entry.get("hint", ""),
            "config": entry.get("config", {}),
        }
        for name, entry in presets.items()
    }


@router.get("/phic/config", response_model=PHICConfig)
async def get_phic_config():
    return phic_state.config


@router.post("/phic/config")
async def update_phic_config(config: PHICConfig):
    config_hash = phic_state.update(config)
    await phic_state.broadcast(config, config_hash)

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
    try:
        await ws.send_text(json.dumps({
            "type":   "phic_update",
            "config": phic_state.config.model_dump(),
        }))
        while True:
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
