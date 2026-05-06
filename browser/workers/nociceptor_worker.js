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
const VPIN_HIGHVOL_DEFAULT  = 0.40;
const LATENCY_CEILING       = 150.0; // ms
const SKEW_CEILING          = 50.0;  // ms
const POLL_INTERVAL_MS      = 8;     // target <8ms decision

// ── Dynamic hurdle configuration ──────────────────────────────────────────
// Strategy classification governs asymmetric VPIN response:
//   mean_reversion → punished heavily by informed flow (VPIN = freight train)
//   momentum       → discounted (VPIN = tailwind, not headwind)
const STRATEGY_TYPE = {
  MOMENTUM_V1:          "momentum",
  DEPTH_GRAB:           "momentum",
  SUPERTREND_CROSS:     "momentum",        // trend-following — benefits from directional flow
  WHALE_WAKE:           "momentum",        // rides institutional flow — VPIN is a tailwind
  ARBI_CROSS_EXCHANGE:  "arb",             // market-neutral timing edge — VPIN irrelevant
  REVERSION_A:          "mean_reversion",
  SPREAD_FADE:          "mean_reversion",
};

// Exponent for the regime strain multiplier in:
//   Hurdle = BaseExecCost × e^(strain) × vpinMultiplier
const REGIME_STRAIN_EXP = { LowVol: 0.0, HighVol: 0.5, Crisis: 1.5 };

let _reader      = null;
let _phic        = { autonomy_level: 0.5, vetoed_patterns: [], regime_caps: {}, emergency_freeze: false };
let _latencyEWMA = null;   // null = unseeded; set on first real sample
let _passiveOnly = false;
let _lastVpin    = 0;  // retained so _dynamicHurdle can read current toxicity level
let _vpinAlertLastAt = 0;  // throttle: emit sentinel_alert at most once per 3s when VPIN > crisis
const VPIN_ALERT_COOLDOWN_MS = 3_000;

// Rolling VPIN state
let _buyVol  = 0;
let _sellVol = 0;
const EWMA_FAST = 0.05;  // halflife ≈ 13 ticks (~100ms); 0.2 was too reactive to single-tick bursts

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

  for (const t of ticks) {
    // Accumulate EWMA volume per side
    _buyVol  = _buyVol  * (1 - EWMA_FAST) + (t.side === "buy"  ? t.volume : 0) * EWMA_FAST;
    _sellVol = _sellVol * (1 - EWMA_FAST) + (t.side === "sell" ? t.volume : 0) * EWMA_FAST;
  }

  const total = _buyVol + _sellVol;
  const vpin  = total > 0 ? Math.abs(_buyVol - _sellVol) / total : 0;
  _lastVpin   = vpin;
  const now   = Date.now();

  // Use PHIC-calibrated thresholds — Navigator proactive_overrides take precedence
  const vpinCrisis  = _phic.proactive_overrides?.vpin_threshold_override
                      ?? _phic.vpin_crisis_threshold  ?? VPIN_CRISIS_DEFAULT;
  const vpinHighVol = _phic.vpin_highvol_threshold ?? VPIN_HIGHVOL_DEFAULT;

  self.postMessage({ type: "vpin_update", vpin: +vpin.toFixed(4), toxic: vpin > vpinCrisis,
    highvol: vpin > vpinHighVol, timestamp: now });

  if (vpin > vpinCrisis && !_phic.emergency_freeze && now - _vpinAlertLastAt >= VPIN_ALERT_COOLDOWN_MS) {
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

  const lat = _latencyEWMA ?? 0;
  if (lat > LATENCY_CEILING || skewMs > SKEW_CEILING) {
    _passiveOnly = true;
    if (!wasPassive) {
      self.postMessage({
        type:          "sentinel_alert",
        sentinel_type: "Proprioceptor",
        action:        "FORCE_PASSIVE",
        severity:      +Math.min(lat / 300, 1.0).toFixed(3),
        detail:        `EWMA=${lat.toFixed(1)}ms skew=${skewMs.toFixed(1)}ms`,
        timestamp:     now,
      });
    }
  } else if (lat < LATENCY_CEILING * 0.7 && skewMs < SKEW_CEILING * 0.7) {
    _passiveOnly = false;
  }
}

// Hurdle = BaseExecCost × e^(regimeStrain) × vpinMultiplier(strategyType)
// LowVol+clean flow: hurdle ≈ base cost. Crisis+toxic flow: mean-reversion
// hurdle can be 4–10× base cost, momentum hurdle is eased (VPIN = tailwind).
function _dynamicHurdle(patternId, baseExecCost, regimeTag) {
  // PHIC-override first; hardcoded defaults as fallback.
  // Navigator proactive_overrides.risk_multiplier scales the whole hurdle.
  const strain      = _phic.regime_strain_exp?.[regimeTag] ?? REGIME_STRAIN_EXP[regimeTag] ?? 0;
  const type        = STRATEGY_TYPE[patternId] ?? "momentum";
  const vpinCrisis  = _phic.proactive_overrides?.vpin_threshold_override
                      ?? _phic.vpin_crisis_threshold ?? VPIN_CRISIS_DEFAULT;
  const vpinOver    = Math.max(0, _lastVpin - vpinCrisis);
  const vpinMult = type === "mean_reversion"
    ? 1 + vpinOver * 8
    : type === "arb"
    ? 1.0
    : Math.max(0.5, 1 - vpinOver * 2);
  // risk_multiplier from Navigator (1.0 = normal, 0.3 = Crisis caution)
  const riskMult    = _phic.proactive_overrides?.risk_multiplier ?? 1.0;
  return { hurdle: baseExecCost * Math.exp(strain) * vpinMult * riskMult, vpinCrisis, vpinMult };
}

function _runMetabolic(msg) {
  const { pattern_id, gross_delta, maker_fee, taker_fee, slippage, regime_tag } = msg;

  if (_phic.vetoed_patterns?.includes(pattern_id)) {
    self.postMessage({ type: "signal_drop", pattern_id, reason: "PHIC_VETO", net_alpha: 0, hurdle: 0 });
    return;
  }
  if (_phic.emergency_freeze || _passiveOnly) {
    self.postMessage({ type: "signal_drop", pattern_id, reason: _phic.emergency_freeze ? "FREEZE" : "PASSIVE", net_alpha: 0, hurdle: 0 });
    return;
  }

  const direction    = gross_delta >= 0 ? "buy" : "sell";
  const baseExecCost = maker_fee + taker_fee + slippage;
  const netAlpha     = Math.abs(gross_delta) - baseExecCost;
  const { hurdle, vpinCrisis, vpinMult } = _dynamicHurdle(pattern_id, maker_fee + taker_fee, regime_tag);
  const regimeCap    = _phic.regime_caps?.[regime_tag] ?? Infinity;
  const stratType    = STRATEGY_TYPE[pattern_id] ?? "?";
  const now          = Date.now();

  if (netAlpha >= hurdle) {
    self.postMessage({ type: "signal_pass", pattern_id, gross_delta, net_alpha: netAlpha, direction, hurdle, regime_tag, regime_cap: regimeCap, vpin: +_lastVpin.toFixed(4), timestamp: now });
  } else {
    self.postMessage({
      type:          "sentinel_alert",
      sentinel_type: "Metabolic",
      action:        "DROP_SIGNAL",
      severity:      0.3,
      detail:        `${pattern_id}(${stratType}) NetAlpha=${netAlpha.toFixed(6)} < hurdle=${hurdle.toFixed(6)} [regime=${regime_tag} VPIN=${_lastVpin.toFixed(3)} crisis=${vpinCrisis.toFixed(3)} mult=${vpinMult.toFixed(3)}]`,
      timestamp:     now,
    });
    self.postMessage({ type: "signal_drop", pattern_id, net_alpha: netAlpha, hurdle, timestamp: now });

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
