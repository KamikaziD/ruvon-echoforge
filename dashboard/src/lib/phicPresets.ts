/**
 * ⚠️  SINGLE SOURCE OF TRUTH for SAFE / BALANCED / AGGRESSIVE preset values.
 *
 * Both the dashboard (this file) and the browser runtime (phic_defaults.js) must
 * stay in sync with these values.  When you change a preset here, update
 * phic_defaults.js to match — the bridge serves GET /api/v1/phic/presets so
 * the browser fetches the live values on startNode() instead of relying solely
 * on the JS fallback file.
 *
 * Fields intentionally omitted from a preset remain at whatever value the user
 * last set via the sliders — presets are partial overlays, not full replacements.
 */

import type { PHICConfig } from "./store";

export type PresetName = "low" | "medium" | "high";

export interface Preset {
  label:  string;
  hint:   string;
  config: Partial<PHICConfig>;
}

export const PHIC_PRESETS: Record<PresetName, Preset> = {

  // ── low: 24h Safe Mode ────────────────────────────────────────────────────
  // Unattended capital preservation. Smallest positions, active Guardian,
  // REVERSION_A and SPREAD_FADE vetoed (confirmed low win-rate patterns).
  // vpin_crisis_threshold raised to 0.72: session 7c4a8bac showed the old 0.65
  // caused 1,272 regime flips (mean gap 45s) — too noisy for stable pattern execution.
  low: {
    label: "Safe",
    hint:  "24h mode — smallest positions, active Guardian, REVERSION_A + SPREAD_FADE vetoed",
    config: {
      autonomy_level:              0.55,
      max_position_pct:            5,
      max_drawdown_pct:            4,
      drawdown_hysteresis_n:       2,
      max_pattern_exposure_pct:    0.10,
      max_total_exposure_pct:      0.15,
      stop_loss_pct:               1.0,
      stop_loss_sell_frac:         0.75,
      stop_loss_buy_freeze_ms:     600_000,
      cap_trim_buy_freeze_ms:      300_000,
      stop_loss_reentry_buffer:    0.015,
      kelly_payoff_ratio:          1.3,
      bank_profit_threshold_pct:   0.008,
      bank_tier1_frac:             0.75,
      bank_profit_dwell_min:       5,
      inference_fidelity:          0.70,
      correlation_enabled:         true,
      rvr_threshold:               2.0,
      pearson_threshold:           0.50,
      cross_pair_boost:            0.02,
      regime_caps:                 { LowVol: 0.5, HighVol: 0.5, Crisis: 0.0 },
      hurdle_regime_scale:         { LowVol: 0.90, HighVol: 1.10, Crisis: 2.50 },
      min_consensus_pct:           70,
      vpin_crisis_threshold:       0.72,
      vpin_highvol_threshold:      0.40,
      vpin_hysteresis:             0.08,
      guardian_mode:               "active",
      jury_entropy_threshold:      0.30,
      mesh_heat_threshold:         0.70,
      house_money_threshold:       30,
      house_lock_frac:             0.70,
      rolling_sharpe_floor:        -0.3,
      max_crisis_threshold:        0.85,
      strain_nack_threshold:       0.50,
      strain_cooldown_min:         10,
      reduce_only_lowvol_frac:     0,
      regime_dwell_min:            5,
      freeze_recovery_dwell_min:   20,
      freeze_recovery_slip_pct:    0.5,
      freeze_recovery_warmup_min:  15,
      sl_circuit_breaker_n:        2,
      sl_circuit_breaker_window_min: 30,
      dca_aliveness_floor:         0.85,
      vetoed_patterns:             ["REVERSION_A", "SPREAD_FADE"],
      signal_boost:                0.03,
      paper_shadow_alpha:          0.10,
      paper_min_trades:            4,
    },
  },

  // ── medium: Balanced ──────────────────────────────────────────────────────
  // Good risk-adjusted returns, active Guardian, all patterns active.
  // Calibrated from session 7c4a8bac (967 min, 1,936 executed trades).
  medium: {
    label: "Balanced",
    hint:  "Recommended starting point — calibrated active Guardian, all patterns active",
    config: {
      autonomy_level:              0.85,
      max_position_pct:            15,
      max_drawdown_pct:            8,
      drawdown_hysteresis_n:       3,
      max_pattern_exposure_pct:    0.10,
      max_total_exposure_pct:      0.20,
      stop_loss_pct:               2.0,
      stop_loss_sell_frac:         0.45,
      stop_loss_buy_freeze_ms:     600_000,
      cap_trim_buy_freeze_ms:      180_000,
      stop_loss_reentry_buffer:    0.010,
      kelly_payoff_ratio:          1.5,
      bank_profit_threshold_pct:   0.012,
      bank_tier1_frac:             0.60,
      bank_profit_dwell_min:       10,
      inference_fidelity:          0.70,
      correlation_enabled:         true,
      rvr_threshold:               1.2,
      pearson_threshold:           0.45,
      cross_pair_boost:            0.04,
      regime_caps:                 { LowVol: 0.8, HighVol: 1.0, Crisis: 0.0 },
      hurdle_regime_scale:         { LowVol: 0.70, HighVol: 0.95, Crisis: 1.75 },
      min_consensus_pct:           60,
      vpin_crisis_threshold:       0.85,
      vpin_highvol_threshold:      0.50,
      vpin_hysteresis:             0.08,
      guardian_mode:               "active",
      jury_entropy_threshold:      0.40,
      mesh_heat_threshold:         0.80,
      house_money_threshold:       100,
      house_lock_frac:             0.50,
      rolling_sharpe_floor:        -0.7,
      max_crisis_threshold:        0.90,
      strain_nack_threshold:       0.60,
      strain_cooldown_min:         5,
      reduce_only_lowvol_frac:     0.25,
      regime_dwell_min:            5,
      freeze_recovery_dwell_min:   15,
      freeze_recovery_slip_pct:    1.0,
      freeze_recovery_warmup_min:  10,
      sl_circuit_breaker_n:        2,
      sl_circuit_breaker_window_min: 30,
      dca_aliveness_floor:         0.80,
      vetoed_patterns:             [],
      signal_boost:                0.03,
      paper_shadow_alpha:          0.10,
      paper_min_trades:            4,
    },
  },

  // ── high: Aggressive ─────────────────────────────────────────────────────
  // Maximum execution. Wider drawdown tolerance, lower hurdles, larger positions.
  // vpin_crisis_threshold 0.88: aggressive needs very high VPIN to declare crisis.
  // regime_dwell_min 4: even aggressive benefits from 4-min regime stability.
  high: {
    label: "Aggressive",
    hint:  "Max execution — wide drawdown tolerance, faster re-entry, lower hurdles",
    config: {
      autonomy_level:              0.95,
      max_position_pct:            30,
      max_drawdown_pct:            15,
      drawdown_hysteresis_n:       4,
      max_pattern_exposure_pct:    0.35,
      max_total_exposure_pct:      0.60,
      stop_loss_pct:               2.5,
      stop_loss_sell_frac:         0.40,
      stop_loss_buy_freeze_ms:     120_000,
      cap_trim_buy_freeze_ms:      60_000,
      stop_loss_reentry_buffer:    0.005,
      kelly_payoff_ratio:          1.8,
      bank_profit_threshold_pct:   0.020,
      bank_tier1_frac:             0.40,
      bank_profit_dwell_min:       15,
      inference_fidelity:          0.90,
      correlation_enabled:         true,
      rvr_threshold:               1.2,
      pearson_threshold:           0.45,
      cross_pair_boost:            0.06,
      regime_caps:                 { LowVol: 1.0, HighVol: 1.0, Crisis: 0.0 },
      hurdle_regime_scale:         { LowVol: 0.55, HighVol: 0.80, Crisis: 1.50 },
      min_consensus_pct:           50,
      vpin_crisis_threshold:       0.88,
      vpin_highvol_threshold:      0.55,
      vpin_hysteresis:             0.06,
      guardian_mode:               "active",
      jury_entropy_threshold:      0.50,
      mesh_heat_threshold:         0.85,
      house_money_threshold:       200,
      house_lock_frac:             0.35,
      rolling_sharpe_floor:        -0.7,
      max_crisis_threshold:        0.92,
      strain_nack_threshold:       0.70,
      strain_cooldown_min:         3,
      reduce_only_lowvol_frac:     0.50,
      regime_dwell_min:            4,
      freeze_recovery_dwell_min:   10,
      freeze_recovery_slip_pct:    2.0,
      freeze_recovery_warmup_min:  7,
      sl_circuit_breaker_n:        3,
      sl_circuit_breaker_window_min: 30,
      dca_aliveness_floor:         0.75,
      vetoed_patterns:             [],
      signal_boost:                0.05,
      paper_shadow_alpha:          0.12,
      paper_min_trades:            3,
    },
  },
};
