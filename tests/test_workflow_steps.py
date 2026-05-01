"""
Unit tests for EchoForge workflow step functions
(packages/ruvon-echoforge/workflows/steps.py).

The EchoForgeExtension is injected via context.extra so every test can
use a lightweight AsyncMock — no subprocess, no network.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ruvon.models import StepContext, WorkflowJumpDirective
from ruvon_echoforge.workflows.steps import (
    EmergencyFreezeState,
    ModelRetrainState,
    PHICUpdateState,
    apply_phic_config,
    attempt_resume,
    cancel_all_open_orders,
    evaluate_freeze_severity,
    fetch_training_data,
    freeze_echoforge_engine,
    hot_swap_inference_model,
    register_extension,
    unregister_extension,
    validate_phic_config,
)


# ── Helpers ────────────────────────────────────────────────────────────────

def _ctx() -> StepContext:
    """Return a minimal StepContext."""
    return StepContext(workflow_id="test-wf", step_name="TestStep")


@pytest.fixture(autouse=True)
def clean_registry():
    """Remove any registered extension between tests."""
    unregister_extension()
    yield
    unregister_extension()


def _mock_ext() -> AsyncMock:
    """Return a mock EchoForgeExtension with all coroutine methods pre-mocked."""
    ext = AsyncMock()
    ext.push_phic_config  = AsyncMock()
    ext.hot_swap_model    = AsyncMock()
    ext.emergency_freeze  = AsyncMock()
    ext.emergency_resume  = AsyncMock()
    ext._on_telemetry     = AsyncMock()
    return ext


def _run(coro):
    """Run a coroutine in a fresh event loop (used when steps call run_until_complete)."""
    return asyncio.get_event_loop().run_until_complete(coro)


# ── validate_phic_config ──────────────────────────────────────────────────

class TestValidatePhicConfig:

    def test_accepts_valid_config(self):
        state = PHICUpdateState(config={"autonomy_level": 0.5, "vetoed_patterns": ["REVERSION_A"]})
        result = validate_phic_config(state, _ctx())
        assert result == {"validated": True}

    def test_accepts_all_patterns_vetoed_but_autonomy_nonzero(self):
        """All patterns vetoed is OK as long as autonomy > 0."""
        state = PHICUpdateState(config={
            "autonomy_level": 0.1,
            "vetoed_patterns": ["MOMENTUM_V1", "DEPTH_GRAB", "REVERSION_A", "SPREAD_FADE"],
        })
        result = validate_phic_config(state, _ctx())
        assert result["validated"] is True

    def test_accepts_zero_autonomy_without_full_veto(self):
        """Zero autonomy alone is not enough to trigger rejection."""
        state = PHICUpdateState(config={"autonomy_level": 0.0, "vetoed_patterns": []})
        result = validate_phic_config(state, _ctx())
        assert result["validated"] is True

    def test_rejects_all_patterns_vetoed_and_zero_autonomy(self):
        """Complete lockout: all patterns vetoed AND autonomy=0 → jump to DONE."""
        state = PHICUpdateState(config={
            "autonomy_level": 0.0,
            "vetoed_patterns": ["MOMENTUM_V1", "DEPTH_GRAB", "REVERSION_A", "SPREAD_FADE"],
        })
        with pytest.raises(WorkflowJumpDirective) as exc_info:
            validate_phic_config(state, _ctx())
        assert exc_info.value.target_step_name == "DONE"

    def test_empty_config_is_valid(self):
        state = PHICUpdateState(config={})
        result = validate_phic_config(state, _ctx())
        assert result["validated"] is True


# ── apply_phic_config ─────────────────────────────────────────────────────

class TestApplyPhicConfig:

    def test_calls_push_phic_config_with_state_config(self):
        ext = _mock_ext()
        register_extension(ext)
        state = PHICUpdateState(config={"autonomy_level": 0.7}, validated=True)
        result = apply_phic_config(state, _ctx())
        assert "applied_at" in result
        ext.push_phic_config.assert_called_once_with({"autonomy_level": 0.7})

    def test_raises_if_extension_not_injected(self):
        state = PHICUpdateState(config={"autonomy_level": 0.5})
        with pytest.raises(RuntimeError, match="EchoForgeExtension not registered"):
            apply_phic_config(state, _ctx())  # no extension in context


# ── evaluate_freeze_severity ──────────────────────────────────────────────

class TestEvaluateFreezeSeverity:

    def test_triggers_freeze_on_crisis_vpin_and_regime(self):
        state = EmergencyFreezeState(vpin=0.85, regime_tag="Crisis",
                                     vpin_crisis_threshold=0.70)
        result = evaluate_freeze_severity(state, _ctx())
        assert result["severity"] == pytest.approx(0.85)

    def test_skips_freeze_on_low_vpin(self):
        """VPIN below crisis threshold → jump to DONE regardless of regime."""
        state = EmergencyFreezeState(vpin=0.50, regime_tag="Crisis",
                                     vpin_crisis_threshold=0.70)
        with pytest.raises(WorkflowJumpDirective) as exc_info:
            evaluate_freeze_severity(state, _ctx())
        assert exc_info.value.target_step_name == "DONE"

    def test_skips_freeze_on_non_crisis_regime(self):
        """High VPIN but not Crisis regime → jump to DONE."""
        state = EmergencyFreezeState(vpin=0.90, regime_tag="HighVol",
                                     vpin_crisis_threshold=0.70)
        with pytest.raises(WorkflowJumpDirective) as exc_info:
            evaluate_freeze_severity(state, _ctx())
        assert exc_info.value.target_step_name == "DONE"

    def test_severity_capped_at_1(self):
        """Severity must never exceed 1.0 even for VPIN > 1."""
        state = EmergencyFreezeState(vpin=1.0, regime_tag="Crisis",
                                     vpin_crisis_threshold=0.70)
        result = evaluate_freeze_severity(state, _ctx())
        assert result["severity"] <= 1.0


# ── freeze_echoforge_engine ───────────────────────────────────────────────

class TestFreezeEchoforgeEngine:

    def test_calls_emergency_freeze(self):
        ext = _mock_ext()
        register_extension(ext)
        state = EmergencyFreezeState(vpin=0.85, regime_tag="Crisis", severity=0.85)
        result = freeze_echoforge_engine(state, _ctx())
        assert result["freeze_applied"] is True
        ext.emergency_freeze.assert_called_once()

    def test_raises_if_extension_missing(self):
        state = EmergencyFreezeState(vpin=0.85, regime_tag="Crisis")
        with pytest.raises(RuntimeError, match="EchoForgeExtension not registered"):
            freeze_echoforge_engine(state, _ctx())


# ── cancel_all_open_orders ────────────────────────────────────────────────

class TestCancelAllOpenOrders:

    def test_publishes_cancel_all_telemetry(self):
        ext = _mock_ext()
        register_extension(ext)
        state = EmergencyFreezeState(vpin=0.85, regime_tag="Crisis", freeze_applied=True)
        result = cancel_all_open_orders(state, _ctx())
        assert result["orders_cancelled"] == 1
        ext._on_telemetry.assert_called_once()
        msg = ext._on_telemetry.call_args[0][0]
        assert msg["type"] == "cancel_all"
        assert msg["reason"] == "emergency_freeze"


# ── attempt_resume ────────────────────────────────────────────────────────

class TestAttemptResume:

    def test_resumes_when_vpin_cleared(self):
        ext = _mock_ext()
        register_extension(ext)
        state = EmergencyFreezeState(vpin=0.85, vpin_highvol_threshold=0.40)
        result = attempt_resume(state, _ctx(), current_vpin=0.20)
        assert result["resumed"] is True
        ext.emergency_resume.assert_called_once()

    def test_stays_frozen_when_vpin_still_elevated(self):
        ext = _mock_ext()
        register_extension(ext)
        state = EmergencyFreezeState(vpin=0.85, vpin_highvol_threshold=0.40)
        result = attempt_resume(state, _ctx(), current_vpin=0.55)
        assert result["resumed"] is False
        ext.emergency_resume.assert_not_called()

    def test_falls_back_to_state_vpin_when_extra_absent(self):
        """If current_vpin not passed as kwarg, falls back to state.vpin (should stay frozen)."""
        ext = _mock_ext()
        register_extension(ext)
        state = EmergencyFreezeState(vpin=0.85, vpin_highvol_threshold=0.40)
        result = attempt_resume(state, _ctx())  # no current_vpin kwarg
        assert result["resumed"] is False


# ── fetch_training_data ───────────────────────────────────────────────────

class TestFetchTrainingData:

    def test_falls_back_to_synthetic_on_network_error(self):
        """When Binance is unreachable, synthetic data must be returned."""
        state = ModelRetrainState(pair="BTC/USDT", lookback_days=1)
        with patch("httpx.Client") as mock_client_cls:
            mock_client_cls.return_value.__enter__.return_value.get.side_effect = \
                ConnectionError("unreachable")
            result = fetch_training_data(state, _ctx())

        assert result["samples"] > 0
        assert "_X" in result
        assert "_y" in result
        assert len(result["_X"]) == result["samples"]

    def test_limits_lookback_days(self):
        """lookback_days > 30 must be capped at 30 (≤1000 klines)."""
        state = ModelRetrainState(pair="BTC/USDT", lookback_days=999)
        with patch("httpx.Client") as mock_client_cls:
            mock_client_cls.return_value.__enter__.return_value.get.side_effect = \
                ConnectionError("unreachable")
            result = fetch_training_data(state, _ctx())
        # limit = min(30*24*60, 1000) = 1000 — just check we got data
        assert result["samples"] == 1000


# ── hot_swap_inference_model ──────────────────────────────────────────────

class TestHotSwapInferenceModel:

    def test_raises_on_empty_onnx_bytes(self):
        ext = _mock_ext()
        register_extension(ext)
        state = ModelRetrainState(onnx_bytes=b"")
        with pytest.raises(ValueError, match="onnx_bytes is empty"):
            hot_swap_inference_model(state, _ctx())

    def test_calls_hot_swap_model_with_bytes(self):
        ext = _mock_ext()
        register_extension(ext)
        fake_bytes = bytes([0x08, 0x01, 0x02, 0x03])
        state = ModelRetrainState(onnx_bytes=fake_bytes)
        hot_swap_inference_model(state, _ctx())
        ext.hot_swap_model.assert_called_once_with(fake_bytes)
