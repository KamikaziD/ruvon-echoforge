/**
 * Guardian Worker — Safety Governor for the EchoForge trading mesh.
 *
 * Decouples trade intent from execution by running every execution_intent
 * through a validation pipeline before it reaches the execution_worker or
 * daemon.  Runs in shadow mode (log-only) by default; activate via PHIC panel.
 *
 * Message protocol (inbound):
 *   execution_intent   — evaluate and reply with guardian_forward / guardian_nack
 *   phic_update        — sync PHIC config
 *   portfolio_update   — portfolio state for circuit breaker + house money
 *   execution_result   — outcome feedback (win/loss streak)
 *   inference_result   — jury_agreement for entropy killswitch
 *   metrics_update     — exchange_latency_ms for halt trigger
 *   price_tick         — live price for trailing stop + 1-min candles
 *   spread_update      — spread_pct for Lens C
 *   mesh_heat_update   — mesh_buy_pressure for thundering herd
 *   set_mode           — { mode: "shadow"|"active" }
 *   reset_state        — manual reset to NOMINAL
 *
 * Message protocol (outbound):
 *   guardian_forward         — approved (possibly modified) intent
 *   guardian_nack            — blocked intent
 *   guardian_decision        — audit record for every evaluation
 *   guardian_state_change    — state machine transition
 *   guardian_set_trailing_stop   — { price } to execution_worker
 *   guardian_clear_trailing_stop — clear trailing stop
 *   guardian_phic_adjust     — { config } to apply and forward to bridge
 */

"use strict";

// ── State machine ─────────────────────────────────────────────────────────────

let _state = "NOMINAL"; // "NOMINAL" | "CAUTIOUS" | "REDUCE_ONLY" | "VAULT_HOLD" | "HALTED"
let _mode  = "shadow";  // "shadow" | "active"
let _tacticalRetreatUntil  = 0; // timestamp for timed REDUCE_ONLY auto-recovery
let _reduceOnlyEnteredAt   = 0; // when we entered REDUCE_ONLY (for flat-position fast exit)
let _positionFlatAt        = 0; // when portfolio.btc last dropped to zero (for flat-exit dwell)

// Recovery warmup window — set after a successful freeze_recovery_corridor transition.
// During warmup, session_loss_pct and equity_lower_highs circuit breakers are suppressed
// so the first test positions after recovery don't immediately re-trigger REDUCE_ONLY.
// Equity peaks and PnL window are reset at warmup start to erase stale frozen-session state.
let _recoveryWarmupUntil = 0;

// Session-start warmup: scale all buy sizes to 25% for the first session_start_warmup_min minutes.
// Prevents all patterns from opening full positions simultaneously on a volatile session open,
// which caused 13 correlated SLs in the first 2 minutes (bd64492a session).
const _sessionStartAt = Date.now();

// Emergency freeze recovery tracking.
// When echoforge_worker broadcasts emergency_freeze=true (drawdown exceeded max_drawdown_pct),
// we record the time and portfolio value at freeze. Once market calms, enough time has passed,
// and portfolio has not continued deteriorating, guardian clears the freeze and steps to CAUTIOUS.
let _emergencyFreezeActive      = false;
let _emergencyFreezeDetectedAt  = 0;
let _emergencyFreezePortfolioV  = 0;  // total_value at the moment freeze was detected

// ── PHIC config ───────────────────────────────────────────────────────────────

let _phic = {
  guardian_mode:           "shadow",
  conflict_window_ms:      5_000,
  direction_lock_ms:       15_000,
  velocity_loss_n:         3,
  session_loss_pct:        5.0,
  spread_limit_pct:        0.0015,  // 0.15%
  halted_latency_ms:       500,
  auto_recover_wins:       3,
  jury_entropy_threshold:  0.40,
  mesh_heat_threshold:     0.80,
  base_profit_pct:         0.005,   // 0.5% unrealized → ride mode
  rolling_sharpe_floor:    -0.5,
  tactical_retreat_ms:     900_000, // 15 min
  house_money_threshold:   100,     // $ banked
  house_lock_frac:         0.50,
  stop_loss_pct:           1.5,
  // Calibration safety + strain protection
  max_crisis_threshold:    0.90,
  strain_nack_threshold:   0.60,
  strain_cooldown_min:     5,
  vpin_recovery_min:       3,
  // Network / latency tuning
  latency_passive_ceiling_ms: 150,
  clock_skew_ceiling_ms:      50,
};

// ── Portfolio state ───────────────────────────────────────────────────────────

let _portfolio = {
  usdt: 10_000, btc: 0, avg_cost: 0,
  realized_pnl: 0, unrealized_pnl: 0, total_value: 10_000,
  banked_profit: 0, hwm: 10_000,
};

// ── Macro state ───────────────────────────────────────────────────────────────

// Warm-start gate: Guardian blocks all BUY intents until the browser macro_worker
// confirms its buffers are primed (CVD EWMA seeded, depth MA ready).
// The bridge macro_state arrives every 60s via the bridge asyncio task — it is an
// enhancement, not a prerequisite. Requiring bridge confirmation would block trading
// whenever the bridge is unreachable (bridge metrics WS is not wired back to Guardian).
// Timeout: 30s fallback in case WARM_START_CVD message is also lost (e.g. worker crash).
const _macroReady = { bridge: false, browser: false };
let _macroReadyUnlocked = false;  // set once browser source reports ready (or timeout)

// Auto-unlock after 30s as an ultimate fallback
setTimeout(() => {
  if (!_macroReadyUnlocked) {
    _macroReadyUnlocked = true;
    console.warn("[guardian] macro warm-start timeout — unlocking after 30s");
  }
}, 30_000);

let _macroDepth    = "normal";    // latest book depth state from macro_state_partial
let _macroLastVpin = 0;           // latest VPIN forwarded in macro_state_partial (60s)
let _currentVpin   = 0;           // latest VPIN from vpin_update (tick-level, most recent)
let _cvdDivActive  = false;       // true when any CVD divergence (bearish or bullish) is present
let _macroCvdDiv   = "neutral";   // raw CVD state: "bearish_div" | "bullish_div" | "neutral"
let _macroPersistence = "neutral"; // latest persistence signal from macro_state

// ── Vault Governor state ──────────────────────────────────────────────────────
let _vaultHoldEnteredAt = 0;      // ts when VAULT_HOLD was entered; 0 = not in vault

// ── Strain cooldown (echo_snapshot driven) ────────────────────────────────────

const _strainCooldowns = new Map();   // "pattern_id:regime_tag" → cooldown_until_ts

// ── VPIN recovery delay ───────────────────────────────────────────────────────

let _vpinBelowHighVolSince = 0;       // ts when VPIN first dropped below HighVol; 0 = currently elevated
let _lastVpinCrisisAt     = 0;        // ts when VPIN last EXITED crisis (dropped below threshold)
let _vpinCurrentlyCrisis  = false;    // true while VPIN is currently ≥ vpin_crisis_threshold

// ── Lens A: Strategic Conflict ────────────────────────────────────────────────

let _recentIntents = []; // { pattern_id, direction, ts } — last 20

// ── Lens B: PnL Circuit Breaker ───────────────────────────────────────────────

let _consecutiveLosses = 0;
let _recentOutcomes    = []; // { won, ts, pattern_id } — last 10
let _latencyMs         = 0;

// ── VPIN / Jury ───────────────────────────────────────────────────────────────

let _lastJuryAgreement = 0;
let _lastJurySize      = 1;

// ── Lens C: Spread ────────────────────────────────────────────────────────────

let _spreadPct = 0;

// ── Thundering herd (mesh heat) ───────────────────────────────────────────────

let _meshBuyPressure = 0;
let _meshTabCount    = 0;

// ── Trailing stop (ride mode) ─────────────────────────────────────────────────

let _trailingStopActive = false;
let _candles            = []; // last 5 completed 1-min candles
let _currentCandle      = { open: 0, high: 0, low: Infinity, close: 0, ts: 0 };
let _priceHistory       = []; // last 10 price/ts pairs (1s resolution)
const CANDLE_MS         = 60_000;

// ── Equity curve (lower highs + rolling Sharpe) ───────────────────────────────

let _equityPeaks     = []; // { v, ts } — local maxima of total_value
let _equityPrevTv    = 0;
let _equityRising    = false;
let _equityLocalMax  = 0;
let _pnlWindow       = []; // last 60 1-min PnL deltas
let _prevMinutePnl   = null;
let _lastMinuteTs    = 0;

// ── House money ───────────────────────────────────────────────────────────────

let _stopTightened = false;

// ── Tab restore warmup — 2 equity cycles before re-enabling buys ──────────────

let _tabRestoreAt       = 0;  // ts when tab became visible again; 0 = not restoring
let _recoveryCycleCount = 0;  // counts 30s equity checks since tab restore

// ── Stop-loss / cap-trim circuit breaker ─────────────────────────────────────
// Tracks recency of SL fires. When stop-losses cluster (N fires in window_min),
// Guardian escalates: N → CAUTIOUS, N+1 → REDUCE_ONLY.
// Cap trims are tracked separately and escalate more slowly (over-exposure, not loss).

const _slHistory      = [];   // Date.now() timestamps of recent stop-loss episodes
const _capTrimHistory = [];   // Date.now() timestamps of recent cap-trim fires
// SL burst dedup: multiple SLs within SL_BURST_MS of each other count as 1 episode.
// Prevents a correlated liquidation cluster (all patterns SL'd by the same price move)
// from counting as N independent events and triggering REDUCE_ONLY on session open.
const SL_BURST_MS = 10_000;
let _lastSlEpisodeAt = 0;

// ── Inbound message dispatch ──────────────────────────────────────────────────

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "execution_intent":  _handleIntent(msg);                    break;
    case "phic_update":       _onPhicUpdate(msg.config);             break;
    case "portfolio_update":  _onPortfolioUpdate(msg);               break;
    case "execution_result":  _onOutcome(msg);                       break;
    case "inference_result":  _onJuryResult(msg);                    break;
    case "metrics_update":    _latencyMs = msg.exchange_latency_ms || _latencyMs; break;
    case "price_tick":        _onPriceTick(msg);                     break;
    case "spread_update":     _spreadPct = msg.spread_pct || 0;      break;
    case "echo_snapshot":     _onEchoSnapshot(msg.echoes);            break;
    case "vpin_update":       _onVpinUpdate(msg.vpin, msg.highvol ?? false); break;
    case "mesh_heat_update":
      _meshBuyPressure = msg.mesh_buy_pressure ?? 0;
      _meshTabCount    = msg.tab_count ?? 0;
      break;
    case "set_mode":
      _mode = msg.mode === "active" ? "active" : "shadow";
      _broadcastState("mode_changed");
      break;
    case "reset_state": {
      const _wasVault = _state === "VAULT_HOLD";
      _state = "NOMINAL";
      _consecutiveLosses = 0;
      _tacticalRetreatUntil = 0;
      _reduceOnlyEnteredAt  = 0;
      _vaultHoldEnteredAt   = 0;
      if (_wasVault) self.postMessage({ type: "vault_cleared", ts: Date.now() });
      _broadcastState("manual_reset");
      break;
    }
    case "tab_hidden":
      // Background tab — force REDUCE_ONLY immediately; stale prices make buys unsafe.
      _transitionState("REDUCE_ONLY", "tab_hidden");
      _tabRestoreAt       = 0;
      _recoveryCycleCount = 0;
      break;
    case "tab_visible":
      // Start warmup — require 2 × 30s equity cycles before allowing buys again.
      // This prevents re-entry on the stale post-restore price snapshot.
      _tabRestoreAt       = Date.now();
      _recoveryCycleCount = 0;
      break;
    case "stop_loss_fired": _onStopLossFired(msg); break;
    case "cap_trim_fired":  _onCapTrimFired(msg);  break;

    // ── Macro state ──────────────────────────────────────────────────────────
    case "macro_state":
    case "macro_state_partial":
      _onMacroState(msg);
      break;
    case "macro_state_ready":
      _onMacroStateReady(msg.source);
      break;

    case "ping":
      self.postMessage({ type: "pong", ts: msg.ts });
      break;
  }
};

// ── Core evaluation ───────────────────────────────────────────────────────────

function _handleIntent(intent) {
  // Macro warm-start gate: block BUY intents until both bridge and browser
  // macro_worker confirm their historical buffers are primed. This prevents
  // trading into a blind macro state on cold boot.
  if (!_macroReadyUnlocked && intent.direction === "buy") {
    self.postMessage({
      type: "guardian_nack", intent,
      reason: "macro_warm_start_pending", lens: "macro", state: _state,
    });
    return;
  }

  // Check timed auto-recovery and freeze recovery corridor before evaluating
  _checkTacticalRetreatTimeout();
  _checkFreezeRecovery();

  const isShadowCopy = intent._shadow_copy === true;
  const decision     = _evaluate(intent);

  // Audit record — always emitted
  self.postMessage({
    type:        "guardian_decision",
    action:      decision.action,
    reason:      decision.reason ?? "ok",
    lens:        decision.lens   ?? null,
    state:       _state,
    mode:        _mode,
    shadow_copy: isShadowCopy,
    pattern_id:  intent.pattern_id,
    direction:   intent.direction,
    size_mult:   decision.modifications?._guardian_size_mult ?? 1.0,
    ts:          Date.now(),
  });

  if (isShadowCopy) {
    // Trade already dispatched by main thread — log shadow evaluation only, no forward needed
    if (decision.action !== "ACK") {
      self.postMessage({
        type:       "guardian_shadow_log",
        would:      decision.action,
        reason:     decision.reason,
        lens:       decision.lens,
        pattern_id: intent.pattern_id,
      });
    }
    return;
  }

  const isShadow = _mode === "shadow";
  if (isShadow) {
    // Legacy shadow path (guardian spawned but mode not yet set by main thread)
    const fwd = (decision.action === "MOD")
      ? { ...intent, ...decision.modifications }
      : intent;
    self.postMessage({ type: "guardian_forward", intent: fwd });
    if (decision.action !== "ACK") {
      const mult = decision.modifications?._guardian_size_mult;
      console.info(`[guardian·shadow] Would ${decision.action} ${intent.pattern_id} [${decision.lens}]: ${decision.reason}${mult != null ? ` ×${mult.toFixed(2)}` : ""}`);
      self.postMessage({
        type:    "guardian_shadow_log",
        would:   decision.action,
        reason:  decision.reason,
        lens:    decision.lens,
        pattern_id: intent.pattern_id,
      });
    }
  } else if (decision.action === "NACK") {
    console.warn(`[guardian·active] NACK ${intent.pattern_id} [${decision.lens}]: ${decision.reason} | state=${_state}`);
    self.postMessage({
      type:       "guardian_nack",
      intent,
      reason:     decision.reason,
      lens:       decision.lens,
      state:      _state,
    });
  } else {
    const fwd = (decision.action === "MOD")
      ? { ...intent, ...decision.modifications }
      : intent;
    if (decision.action === "MOD") {
      const mult = decision.modifications?._guardian_size_mult;
      console.info(`[guardian·active] MOD ${intent.pattern_id} [${decision.lens}]: ${decision.reason}${mult != null ? ` ×${mult.toFixed(2)}` : ""}`);
    }
    self.postMessage({ type: "guardian_forward", intent: fwd });
  }
}

function _evaluate(intent) {
  // Hard regime gates
  if (_state === "HALTED") {
    return { action: "NACK", reason: "guardian_halted", lens: "regime" };
  }
  if (_state === "VAULT_HOLD" && intent.direction === "buy") {
    return { action: "NACK", reason: "vault_hold_active", lens: "regime" };
  }
  if (_state === "REDUCE_ONLY" && intent.direction === "buy") {
    return { action: "NACK", reason: "reduce_only_no_buys", lens: "regime" };
  }

  // Gate SELL intents when there is no BTC to sell.
  // Without this, sell signals pass the full guardian pipeline (including nociceptor,
  // inference worker, aliveness scoring) even when the position is flat — wasting
  // pipeline capacity and skewing aliveness counters toward patterns with no real outcome.
  if (intent.direction === "sell" && (_portfolio.btc ?? 0) < 0.0001) {
    return { action: "NACK", reason: "no_position_to_sell", lens: "regime" };
  }

  // Post-crisis buy gate: block buys for post_crisis_buy_freeze_ms after VPIN exits crisis,
  // AND while VPIN is still above (crisis_threshold − hysteresis).
  // Previous version used calmThresh = highvol × 0.60 = 0.30 — caused permanent lockout
  // in persistently high-VPIN markets (VPIN 0.80-0.90 never reaches 0.30).
  // Fix: gate is now time-bounded; expires after post_crisis_buy_freeze_ms regardless of VPIN.
  // When VAULT_HOLD exits, _lastVpinCrisisAt is cleared — vault dwell already served
  // the post-crisis protocol, so the gate should not fire redundantly.
  // Mean-reversion patterns remain exempt — their edge is post-crisis dislocation.
  if (intent.direction === "buy" && _lastVpinCrisisAt > 0 && !_vpinCurrentlyCrisis) {
    const meanRevPatterns = new Set(["REVERSION_A", "SPREAD_FADE"]);
    if (!meanRevPatterns.has(intent.pattern_id)) {
      const freezeMs = _phic.post_crisis_buy_freeze_ms ?? 300_000;
      const elapsed   = Date.now() - _lastVpinCrisisAt;
      if (elapsed >= freezeMs) {
        _lastVpinCrisisAt = 0;  // freeze expired — clear so future buys aren't re-blocked
      } else {
        // Within freeze window: block if VPIN is still dangerously close to crisis
        const calmThresh = (_phic.vpin_crisis_threshold ?? 0.85) - (_phic.vpin_hysteresis ?? 0.08);
        if (_currentVpin > calmThresh) {
          return { action: "NACK", reason: `post_crisis_vpin_elevated_${_currentVpin.toFixed(3)}`, lens: "regime" };
        }
      }
    }
  }

  // Strain cooldown gate — pattern produced too many losing signals recently
  const intentKey  = intent.pattern_id + ":" + (intent.regime_tag || "LowVol");
  const coolUntil  = _strainCooldowns.get(intentKey);
  if (coolUntil && Date.now() < coolUntil) {
    const remainMin = Math.ceil((coolUntil - Date.now()) / 60_000);
    return { action: "NACK", reason: `strain_cooldown_${remainMin}min`, lens: "strain" };
  }

  // Lens A — Strategic Conflict
  const a = _lensA(intent);
  if (a) return a;

  // Lens B — PnL Circuit Breaker
  const b = _lensB(intent);
  if (b) return b;

  // Lens C — Macro / Spread Guard
  const c = _lensC(intent);
  if (c) return c;

  // Composite size modifier (VPIN + house money)
  const sizeMult = _compositeSize(intent);

  if (sizeMult < 0.999) {
    return {
      action:        "MOD",
      modifications: { _guardian_size_mult: sizeMult },
      reason:        `size_mult_${sizeMult.toFixed(3)}`,
      lens:          "size",
    };
  }

  return { action: "ACK" };
}

// ── Lens A: Strategic Conflict ────────────────────────────────────────────────

function _lensA(intent) {
  const now    = intent.timestamp || Date.now();
  const window = now - (_phic.conflict_window_ms ?? 5_000);

  // Exposure fill: fraction of allowed position currently committed (0=flat, 1=at cap).
  // Used to determine whether a conflict is meaningful vs. vacuous.
  const btcExposure    = (_portfolio.btc ?? 0) * Math.max(_portfolio.avg_cost || 0, 1);
  const maxExposure    = (_phic.max_total_exposure_pct ?? 0.20) * (_portfolio.total_value || 10_000);
  const exposureFill   = maxExposure > 0 ? btcExposure / maxExposure : 0;
  const conflictThresh = _phic.conflict_position_threshold ?? 0.25;

  // Cross-strategy conflict:
  // Only fires for BUY intents when position is substantially committed (fill ≥ threshold).
  // Below the threshold the position is flat or small — a buy is a fresh entry, not adding
  // to a contested full position. SELL intents are never blocked by conflict — they reduce
  // exposure and are always defensive (no_position_to_sell already gates flat sells upstream).
  let conflict = null;
  if (intent.direction === "buy" && exposureFill >= conflictThresh) {
    conflict = _recentIntents.find(
      (p) => p.pattern_id !== intent.pattern_id &&
             p.ts > window &&
             p.direction !== intent.direction
    );
  }
  if (conflict) {
    if (_state === "NOMINAL") _transitionState("CAUTIOUS", `conflict_${intent.pattern_id}_vs_${conflict.pattern_id}`);
    return {
      action: "NACK",
      reason: `strategy_conflict_${intent.direction}_vs_${conflict.direction}_from_${conflict.pattern_id}`,
      lens:   "A",
    };
  }

  // Per-pattern direction lock — same pattern can't flip within direction_lock_ms.
  // Exempted when the previous direction was "sell" and fill is below threshold:
  // the sell already closed/reduced the position; re-buying is a fresh entry, not a flip-flop.
  const samePattern = _recentIntents.filter((p) => p.pattern_id === intent.pattern_id);
  const lastSame    = samePattern[samePattern.length - 1];
  if (lastSame && lastSame.direction !== intent.direction &&
      (now - lastSame.ts) < (_phic.direction_lock_ms ?? 15_000)) {
    if (!(lastSame.direction === "sell" && exposureFill < conflictThresh)) {
      return {
        action: "NACK",
        reason: `direction_lock_too_soon_${Math.round((now - lastSame.ts) / 1000)}s`,
        lens:   "A",
      };
    }
  }

  // Thundering Herd — >80% of mesh tabs all buying simultaneously
  if (_meshTabCount > 1 &&
      _meshBuyPressure >= _phic.mesh_heat_threshold &&
      intent.direction === "buy") {
    const mult = _compositeSize(intent) * 0.5; // additional 50% cut on top of other factors
    return {
      action:        "MOD",
      modifications: { _guardian_size_mult: Math.max(0.05, mult) },
      reason:        `thundering_herd_${Math.round(_meshBuyPressure * 100)}pct_of_${_meshTabCount}_tabs`,
      lens:          "A",
    };
  }

  // Record intent for future conflict detection
  _recentIntents.push({ pattern_id: intent.pattern_id, direction: intent.direction, ts: now });
  if (_recentIntents.length > 20) _recentIntents.shift();

  return null;
}

// ── Lens B: PnL Circuit Breaker ───────────────────────────────────────────────

function _lensB(intent) {
  // Consecutive loss → CAUTIOUS
  if (_consecutiveLosses >= _phic.velocity_loss_n && _state === "NOMINAL") {
    _transitionState("CAUTIOUS", `${_consecutiveLosses}_consecutive_losses`);
  }

  // Session drawdown → REDUCE_ONLY
  // Suppressed during recovery warmup: the freeze drawdown is still on the books and would
  // immediately re-trigger REDUCE_ONLY on the first post-recovery intent. Warmup window
  // gives test positions room to accumulate wins before this check resumes.
  const inWarmup      = _recoveryWarmupUntil > 0 && Date.now() < _recoveryWarmupUntil;
  // Base is HWM (peak portfolio value). DO NOT use banked_profit as denominator — any non-zero
  // banked amount (even $0.01) is truthy, making banked_profit || total_value resolve to the tiny
  // banked value, then Math.max(1, tiny) = 1, giving 100× phantom drawdown percentages (e.g. 496%).
  // This caused an infinite REDUCE_ONLY loop: position clears → CAUTIOUS → first intent sees
  // ~496% drawdown → REDUCE_ONLY again, forever.
  const sessionBase   = Math.max(1_000, _portfolio.hwm || _portfolio.total_value || 10_000);
  const sessionPnl    = (_portfolio.realized_pnl ?? 0) + (_portfolio.unrealized_pnl ?? 0);
  const drawdownPct   = (sessionPnl < 0) ? (Math.abs(sessionPnl) / sessionBase) * 100 : 0;
  if (!inWarmup && drawdownPct > _phic.session_loss_pct && _state !== "REDUCE_ONLY" && _state !== "HALTED") {
    _transitionState("REDUCE_ONLY", `session_drawdown_${drawdownPct.toFixed(1)}pct`, _phic.tactical_retreat_ms);
    if (intent.direction === "buy") {
      return { action: "NACK", reason: `reduce_only_drawdown_${drawdownPct.toFixed(1)}pct`, lens: "B" };
    }
  }

  // Latency halt
  if (_latencyMs > _phic.halted_latency_ms) {
    _transitionState("HALTED", `api_latency_${Math.round(_latencyMs)}ms`);
    return { action: "NACK", reason: `latency_halted_${Math.round(_latencyMs)}ms`, lens: "B" };
  }

  return null;
}

// ── Lens C: Macro / Spread Guard ──────────────────────────────────────────────

function _lensC(intent) {
  if (_spreadPct > _phic.spread_limit_pct && intent.order_type !== "limit") {
    return {
      action:        "MOD",
      modifications: { order_type: "limit", _guardian_slippage_guard: true },
      reason:        `spread_${(_spreadPct * 100).toFixed(3)}pct_convert_to_limit`,
      lens:          "C",
    };
  }
  return null;
}

// ── Composite size modifier ───────────────────────────────────────────────────

function _compositeSize(intent) {
  const vpin = intent.vpin ?? 0;

  // VPIN recovery delay: use full VPIN brake until VPIN has been below HighVol for vpin_recovery_min
  const recoveryMs  = (_phic.vpin_recovery_min ?? 3) * 60_000;
  const inRecovery  = _vpinBelowHighVolSince > 0 &&
                      (Date.now() - _vpinBelowHighVolSince) < recoveryMs;

  // Currently elevated: VPIN has not yet dipped below HighVol threshold this session
  // (or has been continuously elevated). _vpinBelowHighVolSince=0 means VPIN is still high.
  const highVolThresh        = _phic.vpin_highvol_threshold ?? 0.40;
  const vpinCurrentlyElevated = _vpinBelowHighVolSince === 0 && vpin >= highVolThresh;

  let vpinMult;
  if (_state === "CAUTIOUS" || inRecovery || vpinCurrentlyElevated) {
    // Full VPIN brake — CAUTIOUS state, post-spike recovery, OR VPIN still actively elevated.
    // Prevents large positions from accumulating while the market is toxic regardless of regime tag.
    vpinMult = Math.max(0.05, 1 - Math.min(vpin, 0.95));
  } else {
    // NOMINAL + recovery confirmed: gentle taper only
    vpinMult = Math.max(0.20, 1 - Math.min(vpin * 0.5, 0.80));
  }

  // House Money Protocol
  const houseMult = _houseMoneyMult();

  // Session-start warmup: scale buys to 25% for the first N minutes so all patterns
  // don't open full positions simultaneously on a volatile session open.
  let warmupMult = 1.0;
  if (intent.direction === "buy") {
    const warmupMs = (_phic.session_start_warmup_min ?? 3) * 60_000;
    if (warmupMs > 0 && (Date.now() - _sessionStartAt) < warmupMs) {
      warmupMult = 0.25;
    }
  }

  return Math.max(0.05, vpinMult * houseMult * warmupMult);
}

function _houseMoneyMult() {
  // Use locked_usdt — real extracted USDT — not the paper banked_profit counter
  const locked = _portfolio.locked_usdt ?? _portfolio.banked_profit ?? 0;
  const total  = _portfolio.total_value  ?? 10_000;
  if (locked < _phic.house_money_threshold) return 1.0;
  const safeLocked = locked * _phic.house_lock_frac;
  const available  = Math.max(total - safeLocked, total * 0.20); // always trade min 20%
  return Math.min(1.0, available / total);
}

// ── Outcome tracking ──────────────────────────────────────────────────────────

function _onOutcome(result) {
  const won = (result.outcome_score ?? 0) > 0;
  _recentOutcomes.push({ won, ts: Date.now(), pattern_id: result.pattern_id });
  if (_recentOutcomes.length > 10) _recentOutcomes.shift();

  if (won) {
    _consecutiveLosses = 0;
    // Auto-recover CAUTIOUS after N consecutive wins
    if (_state === "CAUTIOUS" &&
        _recentOutcomes.slice(-_phic.auto_recover_wins).length >= _phic.auto_recover_wins &&
        _recentOutcomes.slice(-_phic.auto_recover_wins).every((o) => o.won)) {
      _transitionState("NOMINAL", `auto_recover_${_phic.auto_recover_wins}_consecutive_wins`);
    }
  } else {
    _consecutiveLosses++;
  }
}

// ── Jury entropy killswitch ───────────────────────────────────────────────────

function _onJuryResult(msg) {
  _lastJuryAgreement = msg.jury_agreement ?? 0;
  _lastJurySize      = msg.jury_size ?? 1;
  const entropy = 1 - _lastJuryAgreement;
  if (_lastJurySize > 1 && entropy > _phic.jury_entropy_threshold && _state === "NOMINAL") {
    _transitionState("CAUTIOUS", `jury_entropy_dis${entropy.toFixed(3)}`);
  }
}

// ── Portfolio update handling ─────────────────────────────────────────────────

function _onPortfolioUpdate(msg) {
  const prevBtcFlat = (_portfolio.btc ?? 0) < 0.0001;
  _portfolio = {
    ..._portfolio,
    usdt:           msg.usdt           ?? _portfolio.usdt,
    btc:            msg.btc            ?? _portfolio.btc,
    avg_cost:       msg.avg_cost       ?? _portfolio.avg_cost,
    realized_pnl:   msg.realized_pnl   ?? _portfolio.realized_pnl,
    unrealized_pnl: msg.unrealized_pnl ?? _portfolio.unrealized_pnl,
    total_value:    msg.total_value    ?? _portfolio.total_value,
    banked_profit:  msg.banked_profit  ?? _portfolio.banked_profit,
    locked_usdt:    msg.locked_usdt    ?? _portfolio.locked_usdt,
    initial_floor:  msg.initial_floor  ?? _portfolio.initial_floor,
    trading_budget: msg.trading_budget ?? _portfolio.trading_budget,
    hwm:            msg.hwm            ?? _portfolio.hwm,
  };

  // Track when position transitions to flat — used by REDUCE_ONLY accelerated exit
  const nowBtcFlat = (_portfolio.btc ?? 0) < 0.0001;
  if (!prevBtcFlat && nowBtcFlat) _positionFlatAt = Date.now();
  else if (!nowBtcFlat)            _positionFlatAt = 0;  // position re-opened, reset clock

  _updateEquityCurve(_portfolio.total_value, _portfolio.realized_pnl, _portfolio.unrealized_pnl);
  _updateHouseMoneyStop(_portfolio.realized_pnl, _portfolio.total_value);
}

// ── Equity curve: lower highs + rolling Sharpe ───────────────────────────────

function _updateEquityCurve(totalValue, realizedPnl, unrealizedPnl) {
  // --- Lower Highs detection ---
  if (totalValue > _equityPrevTv) {
    _equityRising   = true;
    _equityLocalMax = Math.max(_equityLocalMax, totalValue);
  } else if (_equityRising && totalValue < _equityPrevTv) {
    // Peaked — record it
    _equityPeaks.push({ v: _equityLocalMax, ts: Date.now() });
    if (_equityPeaks.length > 6) _equityPeaks.shift();
    _equityRising   = false;
    _equityLocalMax = totalValue;
    // Check 3 consecutive lower peaks
    if (_equityPeaks.length >= 3) {
      const r = _equityPeaks.slice(-3);
      // Suppressed during recovery warmup: equity peaks accumulated during the frozen session
      // represent stale pre-freeze state and don't reflect post-recovery market conditions.
      // Warmup resets _equityPeaks at recovery time so the first 3 genuine post-recovery
      // peaks are needed before this circuit breaker can fire.
      const inWarmupNow = _recoveryWarmupUntil > 0 && Date.now() < _recoveryWarmupUntil;
      if (!inWarmupNow && r[1].v < r[0].v && r[2].v < r[1].v && _state !== "REDUCE_ONLY" && _state !== "HALTED") {
        _transitionState("REDUCE_ONLY", "equity_lower_highs", _phic.tactical_retreat_ms);
      }
    }
  }
  _equityPrevTv = totalValue;

  // --- Rolling Sharpe (1-min PnL deltas) ---
  const now = Date.now();
  if (now - _lastMinuteTs >= 60_000) {
    const curPnl = (realizedPnl ?? 0) + (unrealizedPnl ?? 0);
    if (_prevMinutePnl !== null) {
      _pnlWindow.push(curPnl - _prevMinutePnl);
      if (_pnlWindow.length > 60) _pnlWindow.shift();
    }
    _prevMinutePnl = curPnl;
    _lastMinuteTs  = now;

    if (_pnlWindow.length >= 10) {
      const mean     = _pnlWindow.reduce((a, b) => a + b, 0) / _pnlWindow.length;
      const variance = _pnlWindow.reduce((a, b) => a + (b - mean) ** 2, 0) / _pnlWindow.length;
      const std      = Math.sqrt(variance);
      const sharpe   = std > 0 ? (mean / std) * Math.sqrt(_pnlWindow.length) : 0;
      if (sharpe < _phic.rolling_sharpe_floor && _state === "NOMINAL") {
        _transitionState("CAUTIOUS", `rolling_sharpe_${sharpe.toFixed(2)}`);
      }
    }
  }
}

// ── House Money: drawdown stop tightening ────────────────────────────────────

function _updateHouseMoneyStop(realizedPnl, totalValue) {
  const pct = (realizedPnl ?? 0) / Math.max(1, totalValue ?? 10_000);
  if (pct < -0.02 && !_stopTightened) {
    const tighter = Math.max(0.3, (_phic.stop_loss_pct ?? 1.5) * 0.80);
    self.postMessage({ type: "guardian_phic_adjust", config: { stop_loss_pct: tighter } });
    _stopTightened = true;
  } else if (pct >= 0) {
    _stopTightened = false;
  }
}

// ── Trailing stop (ride mode) ─────────────────────────────────────────────────

function _onPriceTick({ price, ts }) {
  const now = ts || Date.now();

  // 1-min candle maintenance
  if (_currentCandle.open === 0) {
    _currentCandle = { open: price, high: price, low: price, close: price, ts: now };
  } else if (now - _currentCandle.ts >= CANDLE_MS) {
    _candles.push({ ..._currentCandle, close: price });
    if (_candles.length > 5) _candles.shift();
    _currentCandle = { open: price, high: price, low: price, close: price, ts: now };
  } else {
    _currentCandle.high  = Math.max(_currentCandle.high, price);
    _currentCandle.low   = Math.min(_currentCandle.low, price);
    _currentCandle.close = price;
  }

  // Price velocity history (last 10 samples)
  _priceHistory.push({ price, ts: now });
  if (_priceHistory.length > 10) _priceHistory.shift();

  _updateTrailingStop(price, now);
}

function _updateTrailingStop(currentPrice, now) {
  if (!currentPrice || _portfolio.btc <= 0) {
    _clearTrailingStop();
    return;
  }

  const unrealPct = (_portfolio.unrealized_pnl ?? 0) / Math.max(1, _portfolio.total_value ?? 10_000);

  if (unrealPct < _phic.base_profit_pct) {
    _clearTrailingStop(); // below ride-mode threshold
    return;
  }

  // Compute price velocity over last ~5s
  const oldest  = _priceHistory[0];
  const elapsed = oldest ? (now - oldest.ts) / 1000 : 1;
  const velocity = oldest && elapsed > 0 ? (currentPrice - oldest.price) / elapsed : 0;

  const prevCandleLow = _candles.length > 0 ? _candles[_candles.length - 1].low : 0;

  if (velocity > 0 && prevCandleLow > 0) {
    // Price still accelerating: set trailing stop at previous candle low
    self.postMessage({ type: "guardian_set_trailing_stop", price: prevCandleLow });
    _trailingStopActive = true;
  } else if (velocity < 0 && _trailingStopActive) {
    // Momentum reversed: hand back to standard stop-loss
    _clearTrailingStop();
  }
}

function _clearTrailingStop() {
  if (_trailingStopActive) {
    self.postMessage({ type: "guardian_clear_trailing_stop" });
    _trailingStopActive = false;
  }
}

// ── State machine ─────────────────────────────────────────────────────────────

/**
 * Stop-loss circuit breaker.
 *
 * SL fires are a lagging indicator of a deteriorating session. A single SL can be
 * noise; clustered SLs (multiple in a short window) signal a genuine adverse trend.
 * The system should not continue buying into a declining price — that's following losses.
 *
 * sl_circuit_breaker_n (default 2):  N fires in window → CAUTIOUS; N+1 → REDUCE_ONLY.
 * sl_circuit_breaker_window_min (default 30): rolling window for the count.
 */
function _onStopLossFired(msg) {
  const now       = Date.now();
  const windowMs  = (_phic.sl_circuit_breaker_window_min ?? 30) * 60_000;
  const n         = _phic.sl_circuit_breaker_n ?? 2;

  // Burst dedup: SLs within SL_BURST_MS of the last SL are the same episode (correlated
  // liquidation cluster). Only the first fire in a burst advances the episode count.
  const isNewEpisode = (now - _lastSlEpisodeAt) > SL_BURST_MS;
  if (isNewEpisode) {
    _lastSlEpisodeAt = now;
    _slHistory.push(now);
  }
  while (_slHistory.length > 0 && now - _slHistory[0] > windowMs) _slHistory.shift();

  const count = _slHistory.length;
  console.warn(`[guardian] stop_loss_fired fire#${msg.fire_count ?? "?"} episode=${isNewEpisode ? "new" : "same"} episodes=${count} window=${windowMs / 60_000}min`);

  if (_state === "REDUCE_ONLY") return;   // already at max enforcement
  if (count >= n + 1) {
    _transitionState("REDUCE_ONLY", `sl_circuit_${count}_fires_${windowMs / 60_000}min`);
  } else if (count >= n) {
    _transitionState("CAUTIOUS", `sl_circuit_${count}_fires_${windowMs / 60_000}min`);
  }
}

/**
 * Cap-trim circuit breaker.
 *
 * Frequent cap trims mean the system keeps accumulating past the exposure cap —
 * a sign the ensemble is over-eager in the current regime. Escalate more slowly
 * than SL (trims are protective, not lossy) — only CAUTIOUS, never REDUCE_ONLY.
 *
 * Threshold: N+2 cap trims in window → CAUTIOUS (uses same n and window as SL).
 */
function _onCapTrimFired(msg) {
  const now      = Date.now();
  const windowMs = (_phic.sl_circuit_breaker_window_min ?? 30) * 60_000;
  const n        = _phic.sl_circuit_breaker_n ?? 2;

  _capTrimHistory.push(now);
  while (_capTrimHistory.length > 0 && now - _capTrimHistory[0] > windowMs) _capTrimHistory.shift();

  const count = _capTrimHistory.length;
  console.info(`[guardian] cap_trim_fired count=${count} window=${windowMs / 60_000}min`);

  if (_state !== "NOMINAL") return;   // CAUTIOUS/REDUCE_ONLY already provides throttle
  if (count >= n + 2) {
    _transitionState("CAUTIOUS", `cap_trim_${count}_fires_${windowMs / 60_000}min`);
  }
}

function _transitionState(newState, reason, tacticalMs) {
  if (_state === newState) return;
  const prev = _state;
  _state = newState;
  if (tacticalMs && newState === "REDUCE_ONLY") {
    _tacticalRetreatUntil  = Date.now() + tacticalMs;
    _reduceOnlyEnteredAt   = Date.now();
  } else if (newState !== "REDUCE_ONLY") {
    _tacticalRetreatUntil = 0;
    _reduceOnlyEnteredAt  = 0;
    _positionFlatAt       = 0;
  }
  if (newState === "VAULT_HOLD") {
    _vaultHoldEnteredAt = Date.now();
  } else if (prev === "VAULT_HOLD") {
    _vaultHoldEnteredAt = 0;
    _lastVpinCrisisAt   = 0;  // vault dwell served the post-crisis protocol; don't double-gate
  }
  console.info(`[guardian] ${prev} → ${newState} | ${reason} | mode=${_mode}`);
  self.postMessage({ type: "guardian_state_change", state: newState, prev, reason, ts: Date.now() });
}

function _checkTacticalRetreatTimeout() {
  const now = Date.now();
  if (_state === "REDUCE_ONLY" && _tacticalRetreatUntil > 0 && now > _tacticalRetreatUntil) {
    _tacticalRetreatUntil = 0;
    _transitionState("CAUTIOUS", "tactical_retreat_timeout");
  }
  // Fast exit when position is fully flat — nothing left to reduce.
  // Dwell is anchored to _positionFlatAt (when BTC actually reached zero), NOT to when
  // REDUCE_ONLY was entered, so residual positions draining via sells don't eat the window.
  // Default 30s (medium): long enough for settlement, short enough to catch recovery moves.
  if (_state === "REDUCE_ONLY" && _positionFlatAt > 0 &&
      (_portfolio.btc ?? 0) < 0.0001) {
    const flatDwellMs = (_phic.reduce_only_flat_dwell_sec ?? 30) * 1_000;
    if (now - _positionFlatAt >= flatDwellMs) {
      _transitionState("CAUTIOUS", "reduce_only_position_flat");
    }
  }
  // Tab restore warmup: require 2 × 30s = 60s of observed price data before re-enabling buys.
  // Prevents re-entry on the stale post-restore price snapshot.
  if (_tabRestoreAt > 0 && _state === "REDUCE_ONLY" && now - _tabRestoreAt >= 60_000) {
    _tabRestoreAt       = 0;
    _recoveryCycleCount = 0;
    _transitionState("CAUTIOUS", "tab_restored");
  }
}

/**
 * Recovery corridor for emergency_freeze.
 *
 * Session 7c4a8bac: freeze triggered at min 661, VPIN=0.068 (calm market).
 * The session ran frozen for 306 min (31.6% dead time) — no recovery path existed.
 *
 * Recovery requires ALL of:
 *   (1) freeze_recovery_dwell_min elapsed since freeze (default 15 min — enough for
 *       VPIN to confirm the calm period is real, not a brief lull in a cascade)
 *   (2) VPIN below vpin_highvol_threshold for vpin_recovery_min minutes (market calm)
 *   (3) portfolio has not deteriorated from the freeze level — total_value ≥
 *       freeze_portfolio_value × (1 - freeze_recovery_slip_pct/100)
 *       (e.g., at most 1% further decline since freeze — prevents recovery into a falling knife)
 *
 * On recovery: clears emergency_freeze via guardian_phic_adjust (index.html broadcasts
 * to all workers), transitions to CAUTIOUS (not NOMINAL — auto_recover_wins still required).
 */
function _checkFreezeRecovery() {
  if (!_emergencyFreezeActive) return;

  const now = Date.now();

  // (1) Minimum dwell before attempting recovery
  const dwellMs = (_phic.freeze_recovery_dwell_min ?? 15) * 60_000;
  if (now - _emergencyFreezeDetectedAt < dwellMs) return;

  // (2) VPIN must have been calm for vpin_recovery_min minutes
  const recoveryMs   = (_phic.vpin_recovery_min ?? 3) * 60_000;
  const vpinIsCalm   = _vpinBelowHighVolSince > 0 &&
                       (now - _vpinBelowHighVolSince) >= recoveryMs;
  if (!vpinIsCalm) return;

  // (3) Portfolio must not have deteriorated further than the slip tolerance
  const slipPct    = _phic.freeze_recovery_slip_pct ?? 1.0;
  const floorV     = _emergencyFreezePortfolioV * (1 - slipPct / 100);
  if (_portfolio.total_value < floorV) {
    // Still deteriorating — reset the dwell timer so we wait another full window
    _emergencyFreezeDetectedAt = now;
    console.warn(
      `[guardian] freeze recovery check: portfolio $${_portfolio.total_value.toFixed(2)} < ` +
      `floor $${floorV.toFixed(2)} — resetting dwell`
    );
    return;
  }

  // All conditions met — clear the freeze and step to CAUTIOUS
  console.info(
    `[guardian] freeze recovery corridor satisfied — VPIN calm ${((now - _vpinBelowHighVolSince) / 60_000).toFixed(1)}min, ` +
    `portfolio $${_portfolio.total_value.toFixed(2)} ≥ floor $${floorV.toFixed(2)}`
  );
  _emergencyFreezeActive     = false;
  _emergencyFreezeDetectedAt = 0;

  // Warmup window: suppress session_loss_pct and equity_lower_highs circuit breakers
  // for freeze_recovery_warmup_min minutes (default 10).
  //
  // Why needed: the session drawdown that triggered the freeze is still on the books
  // (e.g., -7.18% in session 7c4a8bac). The very first execution_intent evaluated in
  // CAUTIOUS would hit `session_loss_pct=5%` and immediately re-trigger REDUCE_ONLY —
  // undoing the recovery. Warmup suppresses that check while the first test positions run.
  //
  // Also reset equity peaks and PnL window — 300+ min of frozen session have
  // accumulated stale lower-highs and a negative Sharpe that don't reflect the
  // current market; a clean baseline prevents false circuit breaker fires.
  const warmupMs       = (_phic.freeze_recovery_warmup_min ?? 10) * 60_000;
  _recoveryWarmupUntil = now + warmupMs;
  _equityPeaks         = [];
  _equityRising        = false;
  _equityLocalMax      = _portfolio.total_value;
  _pnlWindow           = [];
  _prevMinutePnl       = null;  // re-seed next minute's delta from current PnL
  console.info(`[guardian] warmup window: ${(_phic.freeze_recovery_warmup_min ?? 10)} min (until ${new Date(now + warmupMs).toISOString()})`);

  // Broadcast emergency_freeze=false to all workers via index.html
  self.postMessage({ type: "guardian_phic_adjust", config: { emergency_freeze: false } });
  _transitionState("CAUTIOUS", "freeze_recovery_corridor");
}

function _broadcastState(reason) {
  self.postMessage({ type: "guardian_state_change", state: _state, prev: _state, reason, ts: Date.now() });
}

// ── Strain cooldown from echo_snapshot ───────────────────────────────────────

function _onEchoSnapshot(echoes) {
  if (!echoes?.length) return;
  const now = Date.now();
  for (const e of echoes) {
    const total = (e.strain_count ?? 0) + (e.execution_count ?? 1);
    if (total < 3) continue;  // too few samples to judge
    const strainRatio = (e.strain_count ?? 0) / total;
    const key = e.pattern_id + ":" + e.regime_tag;
    if (strainRatio >= (_phic.strain_nack_threshold ?? 0.60)) {
      // Extend or set cooldown
      const existing  = _strainCooldowns.get(key) ?? 0;
      const coolUntil = now + (_phic.strain_cooldown_min ?? 5) * 60_000;
      if (coolUntil > existing) _strainCooldowns.set(key, coolUntil);
    } else {
      // Only clear once any existing cooldown has elapsed
      const existing = _strainCooldowns.get(key) ?? 0;
      if (now > existing) _strainCooldowns.delete(key);
    }
  }
}

// ── VPIN recovery tracking ────────────────────────────────────────────────────

function _onVpinUpdate(vpin, isHighVol) {
  _currentVpin = vpin;  // tick-level tracking for post-crisis gate
  const highVolThresh  = _phic.vpin_highvol_threshold  ?? 0.40;
  const crisisThresh   = _phic.vpin_crisis_threshold   ?? 0.85;
  const nowCrisis = vpin >= crisisThresh;
  // Start the post-crisis cooldown from when VPIN EXITS crisis, not from every spike within it.
  // Previously, each spike reset _lastVpinCrisisAt so the 300s freeze never expired during a
  // volatile session (VPIN oscillating above crisis threshold every few seconds).
  if (!nowCrisis && _vpinCurrentlyCrisis) {
    // Only arm the freeze clock if the previous freeze has already expired.
    // Without this guard, VPIN oscillating around the crisis threshold resets the
    // clock on every oscillation, extending the 2-min freeze indefinitely.
    const freezeMs = _phic.post_crisis_buy_freeze_ms ?? _phic.cap_trim_buy_freeze_ms ?? 120_000;
    if (_lastVpinCrisisAt === 0 || Date.now() - _lastVpinCrisisAt >= freezeMs) {
      _lastVpinCrisisAt = Date.now();
    }
  }
  _vpinCurrentlyCrisis = nowCrisis;
  if (isHighVol || vpin >= highVolThresh) {
    _vpinBelowHighVolSince = 0;  // VPIN is elevated — reset recovery timer
  } else if (_vpinBelowHighVolSince === 0) {
    _vpinBelowHighVolSince = Date.now();  // just dropped below HighVol — start recovery clock
  }
}

// ── Macro state handlers ─────────────────────────────────────────────────────

function _onMacroStateReady(source) {
  if (source === "bridge")  _macroReady.bridge  = true;
  if (source === "browser") _macroReady.browser = true;
  if (source === "daemon")  _macroReady.browser = true;  // daemon macro_worker = browser equivalent
  // Unlock as soon as the browser/daemon macro_worker confirms ready.
  // Bridge confirmation improves data quality but is not required for trading to resume.
  if (_macroReady.browser && !_macroReadyUnlocked) {
    _macroReadyUnlocked = true;
    const bridgeStatus = _macroReady.bridge ? "bridge+browser" : `${source}-only`;
    console.info("[guardian] macro warm-start complete — %s", bridgeStatus);
  }
}

function _onMacroState(msg) {
  // Update book depth + VPIN gate state (from browser macro_worker)
  if (msg.depth)      _macroDepth    = msg.depth;
  if (msg.last_vpin != null) _macroLastVpin = msg.last_vpin;
  if (msg.persistence) _macroPersistence = msg.persistence;

  // CVD divergence: store flag for audit log; Kelly cap lives in execution_worker
  const prevDiv = _cvdDivActive;
  if (msg.cvd_div != null) _macroCvdDiv = msg.cvd_div;
  _cvdDivActive = _macroCvdDiv === "bearish_div" || _macroCvdDiv === "bullish_div";
  if (_cvdDivActive !== prevDiv) {
    console.info(`[guardian] CVD divergence: ${_macroCvdDiv} (sizing cap in execution_worker)`);
  }

  // Thin book CAUTIOUS gate — only when VPIN is LOW (quiet market = genuine liquidity vacuum).
  // If VPIN is high the thin book is a normal breakout symptom (MMs pulling resting orders
  // to avoid adverse selection) — Guardian ignores it in that case.
  if (_macroDepth === "thin") {
    const vpinThreshold = _phic.vpin_highvol_threshold ?? 0.40;
    if (_macroLastVpin < vpinThreshold && _state === "NOMINAL") {
      _transitionState("CAUTIOUS", `macro_thin_book_vpin=${_macroLastVpin.toFixed(3)}`);
    }
  }

  // Vault governor — evaluate on every macro state update
  _evaluateVaultSecurity(msg);
  _checkVaultRecovery();
}

// ── Vault Governor ────────────────────────────────────────────────────────────

function _evaluateVaultSecurity(msg) {
  if (!(_phic.vault_enabled ?? true)) return;
  // Block until macro_worker buffers are warm — cold CVD/Hurst values trigger false positives
  // on the first macro_state message (computed from only a handful of synthetic ticks).
  if (!_macroReadyUnlocked) return;
  if (_state === "VAULT_HOLD" || _state === "HALTED") return;

  let score = 0;
  const reasons = [];
  const vpin        = msg.last_vpin ?? _macroLastVpin;
  const cvdDiv      = msg.cvd_div ?? _macroCvdDiv;
  const depth       = msg.depth ?? _macroDepth;
  const persistence = msg.persistence ?? _macroPersistence;

  const vpinThreshold = _phic.vault_vpin_threshold ?? 0.85;

  if ((_phic.vault_vpin_trigger ?? true) && vpin > vpinThreshold) {
    score += 2;
    reasons.push(`vpin=${vpin.toFixed(3)}>${vpinThreshold}`);
  }
  if ((_phic.vault_cvd_trigger ?? true) && cvdDiv === "bearish_div") {
    score += 2;
    reasons.push("cvd_bearish_div");
  }
  if ((_phic.vault_hurst_trigger ?? true) && persistence === "reverting") {
    score += 1;
    reasons.push("persistence_reverting");
  }
  if ((_phic.vault_depth_trigger ?? true) && depth === "thin" && vpin < 0.35) {
    score += 1;
    reasons.push(`thin_book_vpin=${vpin.toFixed(3)}`);
  }

  // Default 3: requires at least two signals (bearish CVD + reverting, or VPIN crisis + one more).
  // Single bearish CVD alone (score=2) does not trigger — mock synthetic data and
  // short-window CVD divergence produce spurious bearish_div signals too frequently.
  const threshold = _phic.vault_compromise_score ?? 3;
  if (score < threshold) return;

  const reason = `vault_compromise_score=${score}:${reasons.join(",")}`;
  console.warn(`[guardian] VAULT_HOLD triggered — ${reason}`);
  _transitionState("VAULT_HOLD", reason);
  self.postMessage({ type: "vault_liquidate", reason, score, ts: Date.now() });
}

function _checkVaultRecovery() {
  if (_state !== "VAULT_HOLD") return;
  if (!(_phic.vault_enabled ?? true)) return;

  const now    = Date.now();
  // When the vault successfully liquidated (BTC=0), exposure risk is gone — use a shorter
  // dwell that just waits for macro confirmation, not full position-protection dwell.
  const isFlat = (_portfolio.btc ?? 0) < 0.0001;
  const dwellMs = isFlat
    ? (_phic.vault_flat_dwell_min ?? 3) * 60_000
    : (_phic.vault_dwell_min ?? 15) * 60_000;
  if (now - _vaultHoldEnteredAt < dwellMs) return;

  const vpinThreshold = _phic.vault_vpin_threshold ?? 0.85;
  const vpinClear     = _macroLastVpin < vpinThreshold * 0.80;
  const cvdClear      = _macroCvdDiv !== "bearish_div";  // bullish recovery is fine; only bearish blocks
  const persistClear  = _macroPersistence !== "reverting";

  if (!vpinClear || !cvdClear || !persistClear) return;

  console.info(
    `[guardian] VAULT_HOLD → CAUTIOUS | vpin=${_macroLastVpin.toFixed(3)} cvd=${_macroCvdDiv} persist=${_macroPersistence}`
  );
  _transitionState("CAUTIOUS", "vault_macro_recovered");
  self.postMessage({ type: "vault_cleared", ts: Date.now() });
}

// ── Config sync ───────────────────────────────────────────────────────────────

function _onPhicUpdate(cfg) {
  if (!cfg) return;
  const prevAutonomy = _phic.autonomy_level;
  _phic = { ..._phic, ...cfg };
  if (cfg.guardian_mode) {
    _mode = cfg.guardian_mode;
  }
  // Sync stop_loss_pct for house money calculations
  if (cfg.stop_loss_pct != null) _phic.stop_loss_pct = cfg.stop_loss_pct;

  // Preset-change override: if autonomy_level shifted by >0.10 the user manually
  // switched presets (Balanced→Aggressive, etc.). A deliberate preset change is a
  // human signal to unfreeze — reset the guardian from REDUCE_ONLY to CAUTIOUS and
  // clear the stale SL/cap-trim history that caused the lockout.
  // HALTED (API latency) is not overridden — that requires the latency to drop first.
  if (cfg.autonomy_level != null &&
      prevAutonomy != null &&
      Math.abs(cfg.autonomy_level - prevAutonomy) >= 0.10 &&
      _state === "REDUCE_ONLY" &&
      !_emergencyFreezeActive) {
    _slHistory.length      = 0;
    _capTrimHistory.length = 0;
    _consecutiveLosses     = 0;
    _tacticalRetreatUntil  = 0;
    _lastSlEpisodeAt       = 0;
    _transitionState("CAUTIOUS", `preset_change_autonomy_${prevAutonomy.toFixed(2)}→${cfg.autonomy_level.toFixed(2)}`);
    console.info("[guardian] preset change detected — REDUCE_ONLY cleared, SL history reset");
  }

  // Detect emergency_freeze transitions broadcast by echoforge_worker.
  if (cfg.emergency_freeze === true && !_emergencyFreezeActive) {
    _emergencyFreezeActive     = true;
    _emergencyFreezeDetectedAt = Date.now();
    _emergencyFreezePortfolioV = _portfolio.total_value;
    console.warn(`[guardian] emergency_freeze detected — portfolio=$${_emergencyFreezePortfolioV.toFixed(2)}`);
    _transitionState("REDUCE_ONLY", "emergency_freeze_echoforge");
  } else if (cfg.emergency_freeze === false && _emergencyFreezeActive) {
    // Cleared externally (e.g. manual reset) — sync internal state
    _emergencyFreezeActive     = false;
    _emergencyFreezeDetectedAt = 0;
  }
}

// ── Timers ────────────────────────────────────────────────────────────────────

// Drive flat-position exit check independently of intent flow.
// When BTC=0 and REDUCE_ONLY is blocking all buys, no intents arrive so
// _checkTacticalRetreatTimeout() never fires from _handleIntent(). This
// prevents a 15-min lock-out with zero position.
setInterval(() => {
  if (_state === "REDUCE_ONLY") _checkTacticalRetreatTimeout();
}, 30_000);

// Fallback vault recovery check — fires even if macro_state stops flowing.
setInterval(() => {
  if (_state === "VAULT_HOLD") _checkVaultRecovery();
}, 60_000);
