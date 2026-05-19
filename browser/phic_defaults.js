/**
 * EchoForge PHIC fallback presets — used only when the bridge is unreachable on startup.
 *
 * ⚠️  CANONICAL VALUES LIVE IN: packages/ruvon-echoforge/echoforge.config.yaml
 *     Keep this file in sync when changing preset values.
 *
 * Runtime priority (highest → lowest):
 *   localStorage  >  bridge GET /api/v1/phic/presets  >  window.ECHOFORGE_PHIC_PRESETS (this file)
 *
 * On startNode(), PHICClient fetches GET /api/v1/phic/config from the bridge and subscribes
 * to live updates via the metrics WebSocket — this file is only the cold-start fallback.
 * Individual fields can still be overridden via ECHOFORGE_PHIC_<FIELD>=<json-value> env vars.
 */

window.ECHOFORGE_PHIC_PRESETS = {

  // ── low: 24h Safe Mode ────────────────────────────────────────────────────
  // Unattended capital preservation. Smallest positions, active Guardian,
  // REVERSION_A and SPREAD_FADE vetoed (confirmed low win-rate patterns).
  // vpin_crisis_threshold raised to 0.72: session 7c4a8bac showed the old 0.65
  // caused 1,272 regime flips (mean gap 45s) — too noisy for stable pattern execution.
  low: {
    autonomy_level:             0.55,
    max_position_pct:           5,
    max_drawdown_pct:           4,
    drawdown_hysteresis_n:      2,
    max_pattern_exposure_pct:   0.10,
    max_total_exposure_pct:     0.15,
    stop_loss_pct:              1.0,
    stop_loss_sell_frac:        0.75,    // aggressive exit on stop-loss
    kelly_payoff_ratio:         1.3,
    strain_overrides:           {},
    bank_profit_threshold_pct:  0.008,   // bank at 0.8% — early, small profits
    bank_tier1_frac:            0.75,
    bank_profit_dwell_min:      3,
    inference_fidelity:         0.70,
    correlation_enabled:        true,
    rvr_threshold:              2.0,     // stricter cross-pair confirmation
    pearson_threshold:          0.50,
    cross_pair_boost:           0.02,
    regime_caps:                { LowVol: 0.5, HighVol: 0.5, Crisis: 0.05 },
    hurdle_regime_scale:        { LowVol: 0.90, HighVol: 1.10, Crisis: 2.50 },
    feature_norm_enabled:       false,
    min_consensus_pct:          70,
    vpin_crisis_threshold:      0.72,    // was 0.65; real crisis onset ~0.86 in session data
    vpin_highvol_threshold:     0.40,    // HighVol window: 0.40–0.72
    guardian_mode:              "active",
    jury_entropy_threshold:     0.30,
    mesh_heat_threshold:        0.70,
    house_money_threshold:      30,
    house_lock_frac:            0.70,
    rolling_sharpe_floor:       -0.3,
    max_crisis_threshold:       0.85,
    strain_nack_threshold:      0.50,
    strain_cooldown_min:        10,
    reduce_only_lowvol_frac:    0,       // no LowVol buys during REDUCE_ONLY
    regime_dwell_min:           5,       // was 3; 96.6% of gaps were <2 min — need 5 min stability
    vpin_hysteresis:            0.08,    // additive band below threshold required to exit Crisis/HighVol
    freeze_recovery_dwell_min:  20,      // 20 min dwell before recovery check (conservative — unattended mode)
    freeze_recovery_slip_pct:   0.5,     // tighter: portfolio must not drop >0.5% from freeze level
    freeze_recovery_warmup_min: 15,      // 15 min warmup: suppresses session_loss_pct + equity_lower_highs
    stop_loss_buy_freeze_ms:    600_000,    // 10 min no-buy after stop-loss
    cap_trim_buy_freeze_ms:     300_000,    // 5 min no-buy after cap-trim
    stop_loss_reentry_buffer:   0.015,      // price must be 1.5% above stop trigger to re-enter
    sl_circuit_breaker_n:       2,          // 2 SL fires → CAUTIOUS, 3 → REDUCE_ONLY
    sl_circuit_breaker_window_min: 30,      // rolling window for the SL fire count
    dca_aliveness_floor:        0.85,       // minimum aliveness required to buy into an underwater position
    post_crisis_buy_freeze_ms:  600_000,
    session_start_warmup_min:   5,
    vetoed_patterns:            ["REVERSION_A", "SPREAD_FADE", "WHALE_WAKE"],
    // ── Echo aliveness tuning ──
    signal_boost:               0.03,       // aliveness added per passing signal (post-gate)
    paper_shadow_alpha:         0.10,       // shadow aliveness EWMA learning rate
    paper_min_trades:           4,          // ghost trades required before resurrection
    // ── Macro regime governor ──
    macro_enabled:              true,
    hurst_trending_threshold:   0.55,
    hurst_reverting_threshold:  0.45,
    hurst_window_min:           8,
    cvd_lookback_min:           240,
    cvd_divergence_threshold:   0.15,
    depth_thin_pct:             0.60,       // stricter than medium — less tolerant of thin book
    depth_window_h:             24,
    correlation_depeg_threshold: 0.40,
    correlation_window_h:       1,
    macro_kelly_thin_scale:     0.50,
  },

  // ── medium: Balanced ──────────────────────────────────────────────────────
  // Good risk-adjusted returns, shadow Guardian, all patterns active.
  // Recommended starting point for a calibrated session.
  //
  // Calibrated from session 7c4a8bac (967 min, 1,936 executed trades):
  //   stop_loss_pct 1.5→2.0:    70 SL fires destroyed -$1,214 vs all other strats +$498
  //   stop_loss_sell_frac 0.65→0.45: bimodal score at ±1.0 = cascading double-exit; smaller first bite
  //   rolling_sharpe_floor -0.5→-0.7: suspected freeze trigger at min 661; more tolerance needed
  //   vpin_crisis_threshold 0.78→0.85: mean VPIN at Crisis onset was 0.86 — threshold was 80ms early
  //   vpin_highvol_threshold 0.40→0.50: expand HighVol window 0.50–0.85 to reduce LowVol/Crisis binary
  //   regime_dwell_min 2→5:     1,272 regime flips in 967 min; 96.6% of gaps <2 min
  //   rvr_threshold 1.5→1.2:    ARBI only 74 trades in 16h (85.7% WR) — was starved
  //   pearson_threshold 0.50→0.45: same, help ARBI cross-pair confirm more
  //   stop_loss_buy_freeze_ms: removed duplicate entry (was 600k overridden by 300k later in obj)
  medium: {
    autonomy_level:             0.85,
    max_position_pct:           15,
    max_drawdown_pct:           8,
    drawdown_hysteresis_n:      3,
    max_pattern_exposure_pct:   0.10,
    max_total_exposure_pct:     0.20,
    stop_loss_pct:              2.0,        // was 1.5; 70 SL fires in 16h destroyed the session
    stop_loss_sell_frac:        0.45,       // was 0.65; smaller first bite — let position recover before full exit
    stop_loss_buy_freeze_ms:    600_000,    // 10 min no-buy after stop-loss fires
    cap_trim_buy_freeze_ms:     180_000,    // 3 min no-buy after cap-trim fires
    stop_loss_reentry_buffer:   0.010,      // price must be 1% above stop trigger to re-enter
    kelly_payoff_ratio:         1.5,
    strain_overrides:           {},
    bank_profit_threshold_pct:  0.012,      // bank at 1.2%
    bank_tier1_frac:            0.60,
    bank_profit_dwell_min:      4,
    inference_fidelity:         0.70,
    correlation_enabled:        true,
    rvr_threshold:              1.2,        // was 1.5; ARBI was starved (74 trades, 85.7% WR) — match high preset
    pearson_threshold:          0.45,       // was 0.50; relax cross-pair confirm to capture more ARBI
    cross_pair_boost:           0.04,
    regime_caps:                { LowVol: 0.8, HighVol: 1.0, Crisis: 0.10 },
    hurdle_regime_scale:        { LowVol: 0.70, HighVol: 0.95, Crisis: 1.75 },
    feature_norm_enabled:       false,
    min_consensus_pct:          60,
    vpin_crisis_threshold:      0.85,       // was 0.78; session data: real crisis mean VPIN=0.86; old threshold caused 1,272 flips
    vpin_highvol_threshold:     0.50,       // was 0.40; HighVol window now 0.50–0.85 (binary LowVol/Crisis is bad)
    guardian_mode:              "active",   // was "shadow"; SL circuit breaker and DCA guard need real enforcement
    jury_entropy_threshold:     0.40,
    mesh_heat_threshold:        0.80,
    house_money_threshold:      100,
    house_lock_frac:            0.50,
    rolling_sharpe_floor:       -0.7,       // was -0.5; likely freeze trigger at min 661 — more tolerance before hard stop
    max_crisis_threshold:       0.90,
    strain_nack_threshold:      0.60,
    strain_cooldown_min:        5,
    reduce_only_lowvol_frac:    0.25,
    regime_dwell_min:           5,          // was 2; 96.6% of all regime gaps were <2 min — need 5 min stability gate
    vpin_hysteresis:            0.08,       // additive band below threshold required to exit Crisis/HighVol regime
    freeze_recovery_dwell_min:  15,         // min dwell after emergency_freeze before recovery check
    freeze_recovery_slip_pct:   1.0,        // max further portfolio decline (%) allowed during recovery window
    freeze_recovery_warmup_min: 10,         // 10 min warmup: suppresses session_loss_pct + equity_lower_highs
    stop_loss_buy_freeze_ms:    600_000,    // 10 min no-buy after stop-loss fires
    cap_trim_buy_freeze_ms:     180_000,    // 3 min no-buy after cap-trim fires
    stop_loss_reentry_buffer:   0.010,      // price must be 1% above stop trigger to re-enter
    sl_circuit_breaker_n:       2,          // 2 SL fires → CAUTIOUS, 3 → REDUCE_ONLY
    sl_circuit_breaker_window_min: 30,      // rolling window for the SL fire count
    dca_aliveness_floor:        0.80,       // minimum aliveness required to buy into an underwater position
    post_crisis_buy_freeze_ms:  300_000,
    session_start_warmup_min:   3,
    vetoed_patterns:            ["WHALE_WAKE", "DEPTH_GRAB"],
    // ── Echo aliveness tuning ──
    signal_boost:               0.03,
    paper_shadow_alpha:         0.10,
    paper_min_trades:           4,
    // ── Macro regime governor ──
    macro_enabled:              true,
    hurst_trending_threshold:   0.55,
    hurst_reverting_threshold:  0.45,
    hurst_window_min:           8,
    cvd_lookback_min:           240,
    cvd_divergence_threshold:   0.15,
    depth_thin_pct:             0.50,
    depth_window_h:             24,
    correlation_depeg_threshold: 0.40,
    correlation_window_h:       1,
    macro_kelly_thin_scale:     0.50,
  },

  // ── high: Aggressive ──────────────────────────────────────────────────────
  // Maximum execution. Wider drawdown tolerance, lower hurdles,
  // larger positions, smaller profit-take fraction to let profits run.
  // vpin_crisis_threshold 0.78→0.88: aggressive should require very clear crisis before throttling.
  // regime_dwell_min 2→4: even aggressive sessions benefit from 4-min regime stability.
  high: {
    autonomy_level:             0.95,
    max_position_pct:           30,
    max_drawdown_pct:           15,
    drawdown_hysteresis_n:      4,
    max_pattern_exposure_pct:   0.35,
    max_total_exposure_pct:     0.60,
    stop_loss_pct:              2.5,
    stop_loss_sell_frac:        0.40,    // smaller partial exit — let rest ride
    stop_loss_buy_freeze_ms:    120_000,    // 2 min no-buy after stop-loss (aggressive allows faster re-entry)
    cap_trim_buy_freeze_ms:     60_000,     // 1 min no-buy after cap-trim fires
    stop_loss_reentry_buffer:   0.005,      // 0.5% above stop trigger — tighter gate, faster re-entry
    kelly_payoff_ratio:         1.8,
    strain_overrides:           {},
    bank_profit_threshold_pct:  0.020,      // only bank at 2% — let profits run
    bank_tier1_frac:            0.40,
    bank_profit_dwell_min:      8,
    inference_fidelity:         0.90,
    correlation_enabled:        true,
    rvr_threshold:              1.2,
    pearson_threshold:          0.45,
    cross_pair_boost:           0.06,
    regime_caps:                { LowVol: 1.0, HighVol: 1.0, Crisis: 0.20 },
    hurdle_regime_scale:        { LowVol: 0.55, HighVol: 0.80, Crisis: 1.50 },
    feature_norm_enabled:       false,
    min_consensus_pct:          50,
    vpin_crisis_threshold:      0.88,       // was 0.78; aggressive needs very high VPIN to declare crisis
    vpin_highvol_threshold:     0.55,       // was 0.45; HighVol window: 0.55–0.88
    guardian_mode:              "active",
    jury_entropy_threshold:     0.50,
    mesh_heat_threshold:        0.85,
    house_money_threshold:      200,
    house_lock_frac:            0.35,
    rolling_sharpe_floor:       -0.7,
    max_crisis_threshold:       0.92,
    strain_nack_threshold:      0.70,
    strain_cooldown_min:        3,
    reduce_only_lowvol_frac:    0.50,
    regime_dwell_min:           4,          // was 2; even aggressive benefits from 4-min stability
    vpin_hysteresis:            0.06,       // tighter than medium — aggressive reacts faster
    freeze_recovery_dwell_min:  10,         // faster recovery allowed for aggressive mode
    freeze_recovery_slip_pct:   2.0,        // wider slip tolerance — aggressive accepts more drift
    freeze_recovery_warmup_min: 7,          // shorter warmup — aggressive re-enters faster
    sl_circuit_breaker_n:       3,          // more tolerant — 3 SL fires → CAUTIOUS, 4 → REDUCE_ONLY
    sl_circuit_breaker_window_min: 30,
    dca_aliveness_floor:        0.75,       // slightly lower threshold — aggressive accepts bolder DCA entries
    post_crisis_buy_freeze_ms:  120_000,
    session_start_warmup_min:   2,
    vetoed_patterns:            [],
    // ── Echo aliveness tuning ──
    signal_boost:               0.05,       // aggressive: slightly higher boost to earn momentum
    paper_shadow_alpha:         0.12,       // faster shadow adaptation
    paper_min_trades:           3,          // fewer ghost trades needed for resurrection
    // ── Macro regime governor ──
    macro_enabled:              true,
    hurst_trending_threshold:   0.58,       // wider trending band for aggressive
    hurst_reverting_threshold:  0.42,       // wider reverting band for aggressive
    hurst_window_min:           8,
    cvd_lookback_min:           240,
    cvd_divergence_threshold:   0.15,
    depth_thin_pct:             0.40,       // more tolerant of thin book
    depth_window_h:             24,
    correlation_depeg_threshold: 0.40,
    correlation_window_h:       1,
    macro_kelly_thin_scale:     0.50,
  },
};

// Active factory default — overridden at runtime by the ECHOFORGE_PHIC_PRESET env var
// (server serves it at GET /api/v1/phic/defaults; browser fetches on startNode()).
window.ECHOFORGE_PHIC_DEFAULTS = window.ECHOFORGE_PHIC_PRESETS.medium;
