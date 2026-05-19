/**
 * nociceptor_worker.js — Web Worker 2
 *
 * Responsibilities:
 *   - Nociceptor: compute VPIN from rolling ring-buffer ticks; raise CANCEL_ORDERS when toxic
 *   - Proprioceptor: EWMA latency + clock skew monitoring; raise FORCE_PASSIVE when degraded
 *   - Metabolic Filter: drop signals where NetAlpha < fee hurdle
 *
 * Messages IN:
 *   {type:"init",           sab: SharedArrayBuffer, phic: PHICConfig}
 *   {type:"phic_update",    config: PHICConfig}
 *   {type:"signal",         pattern_id, gross_delta, maker_fee, taker_fee, slippage, regime_tag}
 *   {type:"latency_sample", latency_ms, clock_skew_ms}
 *
 * Messages OUT:
 *   {type:"sentinel_alert",  sentinel_type, action, severity, detail, timestamp}
 *   {type:"signal_pass",     pattern_id, net_alpha, regime_tag}   ← signal cleared metabolic
 *   {type:"signal_drop",     pattern_id, net_alpha, hurdle}       ← signal killed
 *   {type:"vpin_update",     vpin, toxic, timestamp}
 *   {type:"latency_report",  exchange_latency_ms, is_passive}     ← for S(Ex) sovereign scoring
 */

"use strict";

import { RingBufferReader } from "../ring_buffer.js";

// Default thresholds — overridable via PHIC after calibration
const VPIN_CRISIS_DEFAULT   = 0.70;
const VPIN_HIGHVOL_DEFAULT  = 0.35;  // lowered from 0.40 to widen HighVol band vs bimodal VPIN
const LATENCY_CEILING       = 150.0; // ms — overridden by phic.latency_passive_ceiling_ms
const SKEW_CEILING          = 50.0;  // ms — overridden by phic.clock_skew_ceiling_ms
const POLL_INTERVAL_MS      = 8;     // target <8ms decision

// ── Dynamic hurdle configuration ──────────────────────────────────────────
// Strategy classification governs asymmetric VPIN response and regime strain.
// Each type gets its own VPIN multiplier and strain exponent table so the
// metabolic hurdle reflects the economic reality of the strategy:
//   mean_reversion  → punished by informed flow (VPIN = freight train)
//   momentum        → discounted (VPIN = tailwind, directional flow helps)
//   maker           → resting orders killed by toxicity; VPIN ease was wrong
//   trend           → long-memory trend; thrives in vol, low strain in HighVol/Crisis
//   institutional   → TWAP/VWAP piggybacking; moderate VPIN tailwind
//   breakout        → z_score expansion signal; wants high VPIN + stress to confirm
//   arb             → market-neutral timing edge — VPIN irrelevant, strain irrelevant
const STRATEGY_TYPE = {
  MOMENTUM_V1:          "momentum",
  DEPTH_GRAB:           "maker",           // resting orders = VPIN-sensitive; momentum ease was wrong
  SUPERTREND_CROSS:     "trend",           // long-memory trend; thrives in vol, needs different strain
  WHALE_WAKE:           "institutional",   // TWAP/VWAP piggybacking; moderate VPIN tailwind
  ARBI_CROSS_EXCHANGE:  "arb",             // market-neutral timing edge — VPIN irrelevant
  REVERSION_A:          "mean_reversion",
  SPREAD_FADE:          "mean_reversion",
  VOLATILITY_BREAKOUT:  "breakout",        // z_score expansion signal; wants high VPIN + stress
};

// Per-type regime strain exponents. Hurdle = BaseExecCost × e^(strain) × vpinMult.
// PHIC.regime_strain_exp is a global override/fallback if type not found here.
const STRATEGY_STRAIN = {
  // Crisis matches HighVol — mean_reversion has edge in volatile overshoots; higher strain blacklists it silently
  mean_reversion: { LowVol: 0.0, HighVol: 0.3, Crisis: 0.3 },
  momentum:       { LowVol: 0.0, HighVol: 0.4, Crisis: 1.5 },  // Session data: momentum loses in Crisis — tighten
  maker:          { LowVol: 0.2, HighVol: 0.8, Crisis: 2.5 },  // Worst in all stress — resting orders dangerous
  trend:          { LowVol: 0.0, HighVol: 0.0, Crisis: 0.3 },  // Trend LIKES volatility — near-zero strain
  institutional:  { LowVol: 0.0, HighVol: 0.2, Crisis: 1.0 },  // Works cross-regime
  breakout:       { LowVol: 0.8, HighVol: 0.1, Crisis: 0.0 },  // Breakout needs stress; penalise in LowVol
  arb:            { LowVol: 0.0, HighVol: 0.0, Crisis: 0.0 },  // Timing edge — strain irrelevant
};
// Legacy fallback (PHIC.regime_strain_exp overrides this globally)
const REGIME_STRAIN_EXP = { LowVol: 0.0, HighVol: 0.5, Crisis: 1.5 };

// Structural regime gates: hard-drop signals before metabolic evaluation.
// Patterns that have no edge in a regime should be gated here, not by hurdle alone,
// so they don't consume nociceptor cycles or generate misleading drop records.
const REGIME_REQUIREMENTS = {
  SUPERTREND_CROSS:    ["LowVol", "HighVol", "Crisis"],  // crossovers fire during regime transitions — quorum lags VPIN, so tag is often LowVol even in volatile market
  VOLATILITY_BREAKOUT: ["HighVol", "Crisis"],  // no LowVol echo seed; ghost trades lose in downtrends → permanent hibernation
};

// Dynamic hurdle scaling by regime — LowVol relaxes the hurdle to increase pass rate
// and keep echo aliveness fed. Crisis tightens it. Overridable via PHIC hurdle_regime_scale.
const HURDLE_REGIME_SCALE_DEFAULT = { LowVol: 0.85, HighVol: 1.0, Crisis: 1.20 };

// Per-type VPIN multiplier functions. vpinOver = max(0, (vpin-crisis)/(1-crisis)) — normalised.
// Defined as functions so future formulas can be non-linear without restructuring.
const VPIN_MULT_FN = {
  mean_reversion: (v) => 1 + v * 8,                      // heavy punishment
  arb:            (_) => 1.0,                             // immune
  momentum:       (v) => 1 + v * 2,                      // penalty in Crisis — data: 52% win, mean -0.048 with tailwind
  maker:          (v) => 1 + v * 6,                       // like reversion but slightly less severe
  trend:          (v) => Math.max(0.4, 1 - v * 1.5),     // trend loves vol; only cap extremes
  institutional:  (v) => Math.max(0.5, 1 - v * 1.8),     // moderate tailwind
  breakout:       (v) => Math.max(0.2, 1 - v * 0.5),     // wants VPIN; minimal penalty
};

let _reader      = null;
let _phic        = { autonomy_level: 0.5, vetoed_patterns: [], regime_caps: {}, emergency_freeze: false };
let _phicSeq     = 0;

// ── Macro state ───────────────────────────────────────────────────────────────
// Neutral defaults — safe before warm-start completes (no bias, no hurdle adjustment).
let _macroState = { persistence: "random", cvd_div: "neutral", depth: "normal", correlation: "pegged" };

// MACRO_HURDLE_MULT: pre-factor applied BEFORE the existing VPIN strain formula.
// Outer layer: hurdle = baseExecCost × _macroPreFactor(type, direction)
//                                    × e^(strain) × vpinMult × regimeScale
const MACRO_HURDLE_MULT = {
  //                        trending  random  reverting
  mean_reversion:    { trending: 2.5,  random: 1.0, reverting: 0.75 },
  momentum:          { trending: 0.75, random: 1.0, reverting: 2.0  },
  breakout:          { trending: 0.75, random: 1.0, reverting: 4.0  },
  maker:             { trending: 1.0,  random: 1.0, reverting: 1.0  },  // thin-book veto overrides
  institutional:     { trending: 1.0,  random: 1.0, reverting: 1.0  },  // de-peg modulated separately
  arb:               { trending: 1.0,  random: 1.0, reverting: 1.0  },  // market-neutral — immune
  trend:             { trending: 0.75, random: 1.0, reverting: 2.5  },
};
let _latencyEWMA = null;   // null = unseeded; set on first real sample
let _passiveOnly = false;
let _lastVpin    = 0;  // retained so _dynamicHurdle can read current toxicity level
let _vpinAlertLastAt = 0;  // throttle: emit sentinel_alert at most once per 3s when VPIN > crisis
const VPIN_ALERT_COOLDOWN_MS = 3_000;

// Rolling VPIN state
let _buyVol  = 0;
let _sellVol = 0;
// Reduced from 0.05 — session data showed bimodal VPIN (LowVol↔Crisis, no HighVol) because
// 0.05 reacts to brief one-sided bursts faster than the 0.40–0.70 band can register.
// 0.02 gives ~270ms halflife so VPIN spends meaningful time in the HighVol band.
// Overridable at runtime via phic.vpin_ewma_alpha.
const EWMA_FAST_DEFAULT = 0.02;

// Cold-start guard: with both sides at 0, the first buy tick gives VPIN=1.0 (100% imbalance)
// which triggers a false Crisis regime and CANCEL_ORDERS at t=0. Suppress VPIN emission until
// the ring buffer has seeded with enough real ticks so the EWMA has settled.
const VPIN_WARMUP_TICKS = 100;
let _warmupTicks = 0;

// Stateful regime — asymmetric hysteresis prevents rapid LowVol↔Crisis oscillation.
// Session 7c4a8bac: 1,272 regime flips in 967 min (one every 45s) with raw threshold
// comparisons. With hysteresis, once Crisis is entered the VPIN must fall a full
// hysteresis band below the crisis threshold before returning to HighVol.
// Default band: 0.08 (overridable via phic.vpin_hysteresis).
let _currentRegime = "LowVol";

/**
 * Returns the regime based on current VPIN using stateful hysteresis.
 * Asymmetric: entering a higher regime requires crossing the threshold;
 * exiting requires falling a full hysteresis band below it.
 */
function _getRegime(vpin, vpinCrisis, vpinHighVol) {
  const band = _phic.vpin_hysteresis ?? 0.08;
  switch (_currentRegime) {
    case "LowVol":
      if (vpin >= vpinCrisis)  { _currentRegime = "Crisis";  break; }
      if (vpin >= vpinHighVol) { _currentRegime = "HighVol"; break; }
      break;
    case "HighVol":
      if (vpin >= vpinCrisis)                  { _currentRegime = "Crisis";  break; }
      if (vpin < vpinHighVol - band)            { _currentRegime = "LowVol"; break; }
      break;
    case "Crisis":
      // Must cool down a full band below the crisis threshold before returning to HighVol.
      // From HighVol, a further band drop returns to LowVol via normal HighVol exit logic.
      if (vpin < vpinCrisis - band)             { _currentRegime = "HighVol"; break; }
      break;
    default:
      _currentRegime = "LowVol";
  }
  return _currentRegime;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      _reader = new RingBufferReader(msg.sab);
      _phic   = msg.phic || _phic;
      _startLoop();
      break;
    case "phic_update":
      _phic = { ..._phic, ...(msg.config || {}) };
      if (msg.config?.phic_seq != null) _phicSeq = msg.config.phic_seq;
      break;
    case "macro_state":
    case "macro_state_partial":
      // Merge bridge fields (persistence, cvd_div, correlation) + browser fields (depth)
      _macroState = { ..._macroState, ...(msg.depth      ? { depth:       msg.depth }      : {}),
                                      ...(msg.persistence ? { persistence: msg.persistence } : {}),
                                      ...(msg.cvd_div     ? { cvd_div:     msg.cvd_div }     : {}),
                                      ...(msg.correlation ? { correlation: msg.correlation } : {}) };
      break;
    case "latency_sample": {
      const s = msg.latency_ms;
      // Seed with first real measurement; use EWMA thereafter
      _latencyEWMA = _latencyEWMA === null ? s : _latencyEWMA * 0.9 + s * 0.1;
      _checkProprioceptor(msg.clock_skew_ms || 0);
      break;
    }
    case "signal":
      _runMetabolic(msg);
      break;
    case "tab_hidden":
      // Background tab — normal latency-recovery path still applies but block signal pass
      _passiveOnly = true;
      break;
    case "tab_visible":
      // Let _checkProprioceptor re-evaluate on next latency_sample before clearing passiveOnly
      // (it will clear automatically when lat < 70% ceiling and skew < 70% ceiling)
      break;
    case "ping":
      self.postMessage({ type: "pong", ts: msg.ts });
      break;
  }
};

const LATENCY_REPORT_INTERVAL_MS = 1_000;  // feed S(Ex) scorer every second

function _startLoop() {
  setInterval(_pollRingBuffer, POLL_INTERVAL_MS);
  setInterval(_emitLatencyReport, LATENCY_REPORT_INTERVAL_MS);
}

function _emitLatencyReport() {
  if (_latencyEWMA === null) return;   // nothing to report until first real sample
  self.postMessage({
    type:                 "latency_report",
    exchange_latency_ms:  +_latencyEWMA.toFixed(2),
    is_passive:           _passiveOnly,
  });
}

function _pollRingBuffer() {
  if (!_reader) return;

  const ticks = _reader.readBatch(32);
  if (ticks.length === 0) return;

  const ewmaAlpha = _phic.vpin_ewma_alpha ?? EWMA_FAST_DEFAULT;
  for (const t of ticks) {
    // Accumulate EWMA volume per side
    _buyVol  = _buyVol  * (1 - ewmaAlpha) + (t.side === "buy"  ? t.volume : 0) * ewmaAlpha;
    _sellVol = _sellVol * (1 - ewmaAlpha) + (t.side === "sell" ? t.volume : 0) * ewmaAlpha;
  }
  _warmupTicks += ticks.length;

  const total = _buyVol + _sellVol;
  // During warm-up report 0.0 (neutral LowVol) — prevents false Crisis/CANCEL_ORDERS at t=0
  const vpin  = (_warmupTicks < VPIN_WARMUP_TICKS || total === 0)
                ? 0.0
                : Math.abs(_buyVol - _sellVol) / total;
  _lastVpin   = vpin;
  const now   = Date.now();

  // Use PHIC-calibrated thresholds — Navigator proactive_overrides take precedence
  const vpinCrisis  = _phic.proactive_overrides?.vpin_threshold_override
                      ?? _phic.vpin_crisis_threshold  ?? VPIN_CRISIS_DEFAULT;
  const vpinHighVol = _phic.vpin_highvol_threshold ?? VPIN_HIGHVOL_DEFAULT;

  // Stateful regime with hysteresis — prevents rapid oscillation when VPIN hovers at boundary.
  const regime   = _getRegime(vpin, vpinCrisis, vpinHighVol);
  const toxic    = regime === "Crisis";
  const isHighVol = regime === "HighVol" || regime === "Crisis";

  self.postMessage({ type: "vpin_update", vpin: +vpin.toFixed(4), toxic, highvol: isHighVol,
    regime, timestamp: now });

  if (toxic && !_phic.emergency_freeze && now - _vpinAlertLastAt >= VPIN_ALERT_COOLDOWN_MS) {
    _vpinAlertLastAt = now;
    self.postMessage({
      type:          "sentinel_alert",
      sentinel_type: "Nociceptor",
      action:        "CANCEL_ORDERS",
      severity:      +Math.min(vpin, 1.0).toFixed(3),
      detail:        `VPIN=${vpin.toFixed(3)} > crisis=${vpinCrisis.toFixed(3)}`,
      timestamp:     now,
    });
  }
}

function _checkProprioceptor(skewMs) {
  const now = Date.now();
  const wasPassive = _passiveOnly;

  const lat     = _latencyEWMA ?? 0;
  const latCeil = _phic.latency_passive_ceiling_ms ?? LATENCY_CEILING;
  const skewCeil = _phic.clock_skew_ceiling_ms ?? SKEW_CEILING;
  if (lat > latCeil || skewMs > skewCeil) {
    _passiveOnly = true;
    if (!wasPassive) {
      self.postMessage({
        type:          "sentinel_alert",
        sentinel_type: "Proprioceptor",
        action:        "FORCE_PASSIVE",
        severity:      +Math.min(lat / (latCeil * 2), 1.0).toFixed(3),
        detail:        `EWMA=${lat.toFixed(1)}ms skew=${skewMs.toFixed(1)}ms (ceil=${latCeil}/${skewCeil}ms)`,
        timestamp:     now,
      });
    }
  } else if (lat < latCeil * 0.7 && skewMs < skewCeil * 0.7) {
    _passiveOnly = false;
  }
}

// ── Macro pre-factor ─────────────────────────────────────────────────────────

/**
 * Compute the outer-layer macro hurdle multiplier.
 * Applied BEFORE the VPIN strain formula so macro structure pre-filters patterns
 * irrespective of the current 8ms toxicity level.
 *
 * Multiplier sources (product of all applicable):
 *   1. Hurst persistence × MACRO_HURDLE_MULT[type][persistence]
 *   2. CVD directional   — bearish_div blocks buys for breakout (× 4.0); similar for sells
 *   3. Thin book         — DEPTH_GRAB: veto (Infinity); others: × macro_kelly_thin_scale
 *   4. De-peg            — WHALE_WAKE / institutional: × 0.75 when BTC/ETH de-pegged
 */
function _macroPreFactor(patternId, direction) {
  if (_phic.macro_enabled === false) return 1.0;

  const type        = STRATEGY_TYPE[patternId] ?? "momentum";
  const persistence = _macroState.persistence ?? "random";
  const cvdDiv      = _macroState.cvd_div     ?? "neutral";
  const depth       = _macroState.depth       ?? "normal";
  const correlation = _macroState.correlation ?? "pegged";

  // 1. Persistence multiplier
  const persistMult = MACRO_HURDLE_MULT[type]?.[persistence] ?? 1.0;

  // 2. CVD directional multiplier — only hurdle modification; Kelly cap is in execution_worker
  let cvdMult = 1.0;
  if (cvdDiv === "bearish_div" && direction === "buy"  && type === "breakout") cvdMult = 4.0;
  if (cvdDiv === "bullish_div" && direction === "sell" && type === "breakout") cvdMult = 4.0;
  if (cvdDiv === "bearish_div" && direction === "sell" && type === "institutional") cvdMult = 0.80;
  if (cvdDiv === "bullish_div" && direction === "buy"  && type === "institutional") cvdMult = 0.80;

  // 3. Thin book — DEPTH_GRAB hard veto; others × thin_scale
  let depthMult = 1.0;
  if (depth === "thin") {
    if (type === "maker") return Infinity;   // DEPTH_GRAB: absolute veto
    depthMult = _phic.macro_kelly_thin_scale ?? 0.50;
  }

  // 4. De-peg: WHALE_WAKE / institutional gets lower hurdle when de-pegged (idiosyncratic flow)
  let depegMult = 1.0;
  if (correlation === "depegged" && type === "institutional") depegMult = 0.75;

  return persistMult * cvdMult * depthMult * depegMult;
}

// Hurdle = BaseExecCost × macroPreFactor × e^(strain) × vpinMult(type) × riskMult
// Per-type STRATEGY_STRAIN and VPIN_MULT_FN make each strategy respond to
// VPIN and regime stress according to its actual economic behaviour.
function _dynamicHurdle(patternId, baseExecCost, regimeTag, direction = "buy") {
  const type       = STRATEGY_TYPE[patternId] ?? "momentum";
  // Priority: PHIC strain_override (per-type, per-regime) → STRATEGY_STRAIN → PHIC global → hardcoded
  const strain     = _phic.strain_overrides?.[type]?.[regimeTag]
                     ?? STRATEGY_STRAIN[type]?.[regimeTag]
                     ?? _phic.regime_strain_exp?.[regimeTag]
                     ?? REGIME_STRAIN_EXP[regimeTag] ?? 0;
  const vpinCrisis = _phic.proactive_overrides?.vpin_threshold_override
                     ?? _phic.vpin_crisis_threshold ?? VPIN_CRISIS_DEFAULT;
  // Normalised over-threshold VPIN: 0 at crisis level, 1 at full saturation
  const vpinOver   = Math.max(0, (_lastVpin - vpinCrisis) / Math.max(0.01, 1 - vpinCrisis));
  const vpinMult   = (VPIN_MULT_FN[type] ?? VPIN_MULT_FN.momentum)(vpinOver);
  const riskMult    = _phic.proactive_overrides?.risk_multiplier ?? 1.0;
  const strainMult  = type === "arb" ? 1.0 : Math.exp(strain);
  // Regime-aware hurdle scaling: relax in LowVol (higher pass rate → more aliveness boosts),
  // tighten in Crisis (only high-conviction signals survive).
  const regimeScale = _phic.hurdle_regime_scale?.[regimeTag] ?? HURDLE_REGIME_SCALE_DEFAULT[regimeTag] ?? 1.0;
  // Macro pre-factor: outer-layer multiplier from 4-dimensional macro state
  // Applied first so structural context shapes the hurdle before VPIN strain
  const macroPF = _macroPreFactor(patternId, direction);
  if (!isFinite(macroPF)) {
    // Infinite macro multiplier = absolute veto (e.g. thin book + DEPTH_GRAB)
    return { hurdle: Infinity, vpinCrisis, vpinMult, type };
  }
  return { hurdle: baseExecCost * macroPF * strainMult * vpinMult * riskMult * regimeScale, vpinCrisis, vpinMult, type };
}

function _runMetabolic(msg) {
  const { pattern_id, gross_delta, maker_fee, taker_fee, slippage, regime_tag } = msg;

  // Structural regime gate: patterns without structural edge in this regime cannot execute,
  // but are forwarded as shadow_pass so echoforge can paper-trade them to build evidence.
  const _allowedRegimes = REGIME_REQUIREMENTS[pattern_id];
  if (_allowedRegimes && !_allowedRegimes.includes(regime_tag)) {
    const _baseDir   = gross_delta >= 0 ? "buy" : "sell";
    const _baseAlpha = Math.abs(gross_delta) - (maker_fee + taker_fee + slippage);
    self.postMessage({ type: "shadow_pass", pattern_id, direction: _baseDir,
      net_alpha: _baseAlpha, regime_tag, hurdle: null, shadow_reason: "REGIME_GATE",
      vpin: +_lastVpin.toFixed(4), timestamp: Date.now() });
    return;
  }

  if (_phic.vetoed_patterns?.includes(pattern_id)) {
    // Vetoed: cannot execute but must still paper-trade to prove (or disprove) its value.
    // echoforge_worker handles shadow_pass by ghost-trading only — never routes to guardian.
    const _baseDir   = gross_delta >= 0 ? "buy" : "sell";
    const _baseAlpha = Math.abs(gross_delta) - (maker_fee + taker_fee + slippage);
    self.postMessage({ type: "shadow_pass", pattern_id, direction: _baseDir,
      net_alpha: _baseAlpha, regime_tag, hurdle: null, shadow_reason: "VETO",
      vpin: +_lastVpin.toFixed(4), timestamp: Date.now() });
    return;
  }
  if (_phic.emergency_freeze || _passiveOnly) {
    self.postMessage({ type: "signal_drop", pattern_id, reason: _phic.emergency_freeze ? "FREEZE" : "PASSIVE",
      net_alpha: 0, hurdle: 0, vpin: +_lastVpin.toFixed(4), regime_tag, timestamp: Date.now() });
    return;
  }

  const direction    = gross_delta >= 0 ? "buy" : "sell";
  const baseExecCost = maker_fee + taker_fee + slippage;
  const netAlpha     = Math.abs(gross_delta) - baseExecCost;

  // ── Macro trend hard-block ────────────────────────────────────────────────
  // When Hurst confirms persistence=trending AND the EMA (now 30s/120s half-lives)
  // confirms the same direction, hard-block signals that fight the structural trend.
  // This is directional: downtrend blocks mean-reversion/momentum buys (falling-knife);
  // uptrend blocks mean-reversion/momentum sells (selling into strength).
  // Only fires when macro_enabled !== false and persistence is confirmed "trending".
  if (_phic.macro_enabled !== false && _macroState.persistence === "trending") {
    const trendDown  = msg.trend_down ?? false;
    const trendUp    = msg.trend_up   ?? false;
    const stratType  = STRATEGY_TYPE[pattern_id] ?? "momentum";
    const dirBlocked =
      (trendDown && direction === "buy"  && ["mean_reversion", "trend", "momentum"].includes(stratType)) ||
      (trendUp   && direction === "sell" && ["mean_reversion", "trend", "momentum"].includes(stratType));
    if (dirBlocked) {
      self.postMessage({ type: "signal_drop", pattern_id,
        reason: trendDown ? "MACRO_TREND_BEAR" : "MACRO_TREND_BULL",
        net_alpha: netAlpha, hurdle: Infinity,
        vpin: +_lastVpin.toFixed(4), regime_tag, timestamp: Date.now(),
        macro_persistence: _macroState.persistence, macro_cvd: _macroState.cvd_div,
        macro_depth: _macroState.depth, macro_corr: _macroState.correlation });
      return;
    }
  }

  const { hurdle, vpinCrisis, vpinMult, type: stratClass } = _dynamicHurdle(pattern_id, maker_fee + taker_fee, regime_tag, direction);

  // Arb lag noise floor: must exceed LAG_EMIT_THRESHOLD (10ms) set in correlation_worker
  // Use Math.abs() — negative lags (VALR leads BINANCE) have just as much magnitude as positive
  if (stratClass === "arb" && Math.abs(msg.exchange_lag_ms ?? 0) < 10) {
    self.postMessage({ type: "signal_drop", pattern_id, reason: "ARB_LAG_TOO_SMALL",
      net_alpha: netAlpha, hurdle, exchange_lag_ms: msg.exchange_lag_ms ?? null, timestamp: Date.now() });
    return;
  }
  const regimeCap    = _phic.regime_caps?.[regime_tag] ?? Infinity;
  const stratType    = STRATEGY_TYPE[pattern_id] ?? "?";
  const now          = Date.now();

  if (netAlpha >= hurdle) {
    self.postMessage({ type: "signal_pass", pattern_id, gross_delta, net_alpha: netAlpha, direction, hurdle, regime_tag, regime_cap: regimeCap, vpin: +_lastVpin.toFixed(4), phic_seq: _phicSeq,
      macro_persistence: _macroState.persistence, macro_cvd: _macroState.cvd_div,
      macro_depth: _macroState.depth, macro_corr: _macroState.correlation, timestamp: now });
  } else {
    self.postMessage({
      type:          "sentinel_alert",
      sentinel_type: "Metabolic",
      action:        "DROP_SIGNAL",
      severity:      0.3,
      detail:        `${pattern_id}(${stratType}) NetAlpha=${netAlpha.toFixed(6)} < hurdle=${hurdle.toFixed(6)} [regime=${regime_tag} VPIN=${_lastVpin.toFixed(3)} crisis=${vpinCrisis.toFixed(3)} mult=${vpinMult.toFixed(3)}]`,
      timestamp:     now,
    });
    self.postMessage({ type: "signal_drop", pattern_id, net_alpha: netAlpha, hurdle,
      vpin: +_lastVpin.toFixed(4), regime_tag, phic_seq: _phicSeq,
      macro_persistence: _macroState.persistence, macro_cvd: _macroState.cvd_div,
      macro_depth: _macroState.depth, macro_corr: _macroState.correlation, timestamp: now });

    // Pain map — anonymised "we felt pain here" broadcast to mesh peers.
    // Only emitted when VPIN is elevated (≥0.35) so low-quality random drops don't pollute peers.
    if (_lastVpin >= 0.35) {
      self.postMessage({
        type:            "pain_map",
        pattern_id,
        regime_tag,
        strategy_type:   stratType,
        trigger_vpin:    +_lastVpin.toFixed(3),
        hurdle_miss_pct: +(hurdle > 0 ? (hurdle - netAlpha) / hurdle : 1).toFixed(3),
        timestamp:       now,
      });
    }
  }
}
