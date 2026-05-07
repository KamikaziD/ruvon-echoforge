/**
 * EchoForge PHIC Defaults
 *
 * Edit this file to change factory defaults for all nodes.
 * Values saved in localStorage take precedence at runtime.
 *
 * When the daemon is running you can also override via environment variables
 * (see .env.sample) — the daemon exposes them at /api/v1/phic/defaults.
 */
window.ECHOFORGE_PHIC_DEFAULTS = {
  autonomy_level:            0.90,
  max_position_pct:          25,       // integer % — execution_worker divides by 100
  max_drawdown_pct:          15,       // integer %
  drawdown_hysteresis_n:     3,
  max_pattern_exposure_pct:  0.30,     // fraction 0–1
  max_total_exposure_pct:    0.60,     // fraction 0–1
  stop_loss_pct:             1.5,      // raw % (0 = off)
  bank_profit_threshold_pct: 0.019,    // fraction — 1.9% gain triggers Tier 1 banking
  bank_tier1_frac:           0.50,     // fraction — 50% of excess banked immediately
  bank_profit_dwell_min:     10,       // minutes before Tier 2 fallback
  inference_fidelity:        0.70,
  correlation_enabled:       true,
  rvr_threshold:             1.5,
  pearson_threshold:         0.50,
  cross_pair_boost:          0.04,
  regime_caps:               { LowVol: 0.4, HighVol: 1.0, Crisis: 0.1 },
};
