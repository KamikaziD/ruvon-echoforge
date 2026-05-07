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

let _state = "NOMINAL"; // "NOMINAL" | "CAUTIOUS" | "REDUCE_ONLY" | "HALTED"
let _mode  = "shadow";  // "shadow" | "active"
let _tacticalRetreatUntil = 0; // timestamp for timed REDUCE_ONLY auto-recovery

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
  jury_entropy_threshold:  0.15,
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

// ── Strain cooldown (echo_snapshot driven) ────────────────────────────────────

const _strainCooldowns = new Map();   // "pattern_id:regime_tag" → cooldown_until_ts

// ── VPIN recovery delay ───────────────────────────────────────────────────────

let _vpinBelowHighVolSince = 0;       // ts when VPIN first dropped below HighVol; 0 = currently elevated

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
    case "reset_state":
      _state = "NOMINAL";
      _consecutiveLosses = 0;
      _tacticalRetreatUntil = 0;
      _broadcastState("manual_reset");
      break;
  }
};

// ── Core evaluation ───────────────────────────────────────────────────────────

function _handleIntent(intent) {
  // Check timed auto-recovery before evaluating
  _checkTacticalRetreatTimeout();

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
      self.postMessage({
        type:    "guardian_shadow_log",
        would:   decision.action,
        reason:  decision.reason,
        lens:    decision.lens,
        pattern_id: intent.pattern_id,
      });
    }
  } else if (decision.action === "NACK") {
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
    self.postMessage({ type: "guardian_forward", intent: fwd });
  }
}

function _evaluate(intent) {
  // Hard regime gates
  if (_state === "HALTED") {
    return { action: "NACK", reason: "guardian_halted", lens: "regime" };
  }
  if (_state === "REDUCE_ONLY" && intent.direction === "buy") {
    return { action: "NACK", reason: "reduce_only_no_buys", lens: "regime" };
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
  const window = now - _phic.conflict_window_ms;

  // Cross-strategy direction conflict
  const conflict = _recentIntents.find(
    (p) => p.pattern_id !== intent.pattern_id &&
           p.ts > window &&
           p.direction !== intent.direction
  );
  if (conflict) {
    if (_state === "NOMINAL") _transitionState("CAUTIOUS", `conflict_${intent.pattern_id}_vs_${conflict.pattern_id}`);
    return {
      action: "NACK",
      reason: `strategy_conflict_${intent.direction}_vs_${conflict.direction}_from_${conflict.pattern_id}`,
      lens:   "A",
    };
  }

  // Per-pattern direction lock — same pattern can't flip within direction_lock_ms
  const samePattern = _recentIntents.filter((p) => p.pattern_id === intent.pattern_id);
  const lastSame    = samePattern[samePattern.length - 1];
  if (lastSame && lastSame.direction !== intent.direction && (now - lastSame.ts) < _phic.direction_lock_ms) {
    return {
      action: "NACK",
      reason: `direction_lock_too_soon_${Math.round((now - lastSame.ts) / 1000)}s`,
      lens:   "A",
    };
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
  const sessionBanked = Math.max(1, _portfolio.banked_profit || _portfolio.total_value || 10_000);
  const sessionPnl    = (_portfolio.realized_pnl ?? 0) + (_portfolio.unrealized_pnl ?? 0);
  const drawdownPct   = (sessionPnl < 0) ? (Math.abs(sessionPnl) / sessionBanked) * 100 : 0;
  if (drawdownPct > _phic.session_loss_pct && _state !== "REDUCE_ONLY" && _state !== "HALTED") {
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

  let vpinMult;
  if (_state === "CAUTIOUS" || inRecovery) {
    // Full VPIN brake — applies during CAUTIOUS state or post-spike recovery window
    vpinMult = Math.max(0.05, 1 - Math.min(vpin, 0.95));
  } else {
    // NOMINAL + recovery confirmed: gentle taper only
    vpinMult = Math.max(0.20, 1 - Math.min(vpin * 0.5, 0.80));
  }

  // House Money Protocol
  const houseMult = _houseMoneyMult();

  return Math.max(0.05, vpinMult * houseMult);
}

function _houseMoneyMult() {
  const banked = _portfolio.banked_profit ?? 0;
  const total  = _portfolio.total_value  ?? 10_000;
  if (banked < _phic.house_money_threshold) return 1.0;
  const locked    = banked * _phic.house_lock_frac;
  const available = Math.max(total - locked, total * 0.20); // always trade min 20%
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
  if (_lastJurySize > 1 && _lastJuryAgreement > _phic.jury_entropy_threshold && _state === "NOMINAL") {
    _transitionState("CAUTIOUS", `jury_entropy_${_lastJuryAgreement.toFixed(3)}`);
  }
}

// ── Portfolio update handling ─────────────────────────────────────────────────

function _onPortfolioUpdate(msg) {
  _portfolio = {
    ..._portfolio,
    usdt:           msg.usdt           ?? _portfolio.usdt,
    btc:            msg.btc            ?? _portfolio.btc,
    avg_cost:       msg.avg_cost       ?? _portfolio.avg_cost,
    realized_pnl:   msg.realized_pnl   ?? _portfolio.realized_pnl,
    unrealized_pnl: msg.unrealized_pnl ?? _portfolio.unrealized_pnl,
    total_value:    msg.total_value    ?? _portfolio.total_value,
    banked_profit:  msg.banked_profit  ?? _portfolio.banked_profit,
    hwm:            msg.hwm            ?? _portfolio.hwm,
  };

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
      if (r[1].v < r[0].v && r[2].v < r[1].v && _state !== "REDUCE_ONLY" && _state !== "HALTED") {
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

function _transitionState(newState, reason, tacticalMs) {
  if (_state === newState) return;
  const prev = _state;
  _state = newState;
  if (tacticalMs && newState === "REDUCE_ONLY") {
    _tacticalRetreatUntil = Date.now() + tacticalMs;
  } else if (newState !== "REDUCE_ONLY") {
    _tacticalRetreatUntil = 0;
  }
  self.postMessage({ type: "guardian_state_change", state: newState, prev, reason, ts: Date.now() });
}

function _checkTacticalRetreatTimeout() {
  if (_state === "REDUCE_ONLY" && _tacticalRetreatUntil > 0 && Date.now() > _tacticalRetreatUntil) {
    _tacticalRetreatUntil = 0;
    _transitionState("CAUTIOUS", "tactical_retreat_timeout");
  }
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
  const highVolThresh = _phic.vpin_highvol_threshold ?? 0.40;
  if (isHighVol || vpin >= highVolThresh) {
    _vpinBelowHighVolSince = 0;  // VPIN is elevated — reset recovery timer
  } else if (_vpinBelowHighVolSince === 0) {
    _vpinBelowHighVolSince = Date.now();  // just dropped below HighVol — start recovery clock
  }
}

// ── Config sync ───────────────────────────────────────────────────────────────

function _onPhicUpdate(cfg) {
  if (!cfg) return;
  _phic = { ..._phic, ...cfg };
  if (cfg.guardian_mode) {
    _mode = cfg.guardian_mode;
  }
  // Sync stop_loss_pct for house money calculations
  if (cfg.stop_loss_pct != null) _phic.stop_loss_pct = cfg.stop_loss_pct;
}
