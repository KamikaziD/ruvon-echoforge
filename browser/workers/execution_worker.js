/**
 * execution_worker.js — Web Worker 4
 *
 * Responsibilities:
 *   - Receive execution intents from echoforge_worker
 *   - Apply PHIC position sizing (autonomy_level → max_position_pct)
 *   - Submit orders to exchange via REST (rate-limit aware)
 *   - Queue failed/offline orders in IndexedDB SAF queue
 *   - Report outcomes back to echoforge_worker for aliveness update
 *
 * Messages IN:
 *   {type:"init",             phic, exchange_config}
 *   {type:"phic_update",      config}
 *   {type:"execution_intent", pattern_id, net_aliveness, regime_tag, net_alpha}
 *   {type:"routed_intent",    intent}   ← forwarded from non-sovereign peer via mesh
 *   {type:"sovereign_status", is_sovereign}
 *   {type:"saf_replay"}
 *   {type:"network_status",   online: bool}
 *
 * Messages OUT:
 *   {type:"order_submitted",  pattern_id, order_id, symbol, side, qty, timestamp}
 *   {type:"order_failed",     pattern_id, error, timestamp}
 *   {type:"execution_result", pattern_id, outcome_score}     ← to echoforge_worker
 *   {type:"execution_stats",  success_rate, is_rate_limited} ← to echoforge_worker for gossip
 *   {type:"intent_route",     intent}   ← to mesh when not sovereign
 *   {type:"saf_queued",       pattern_id, entry_id}
 *   {type:"saf_status",       pending_count}
 */

"use strict";

let _phic = {
  autonomy_level: 0.5,
  max_position_pct: 1.0,
  emergency_freeze: false,
  regime_caps: {},
};
let _exchangeConfig  = null;
let _online          = true;
let _tabFreeze       = false;  // true when tab is backgrounded — gate all intents
let _rateLimitUntil  = 0;
let _replaying       = false;   // prevents re-enqueue during SAF replay
const SAF_MAX_RETRIES = 5;      // expire SAF entry after this many failed replays

let _isSovereign = true;

// Live price — 0 until first real tick; execution is gated until seeded
let _livePrice = 0;

// Guardian trailing stop — set by guardian_worker when in ride mode
let _trailingStopPrice = 0;

// Per-pattern cooldown — prevent over-trading the same pattern
const _patternLastTrade  = new Map();  // pattern_id → timestamp ms
const PATTERN_COOLDOWN_MS = 30_000;   // 30s minimum between same-pattern trades
const ARB_COOLDOWN_MS     = 200;      // arb signals are time-critical — 200ms cooldown only

// Rolling execution stats
let _execSuccesses = 0;
let _execFailures  = 0;

// Local portfolio mirror (updated from fill responses)
const _portfolio = {
  usdt:          10_000.0,
  btc:           0.0,
  avg_cost:      0.0,
  realized_pnl:  0.0,
  unrealized_pnl:0.0,
  total_value:   10_000.0,
  total_pnl:     0.0,
};

// Profit banking — two-tier velocity-aware system.
//
// Tier 1 (immediate): when total_value exceeds HWM by bank_profit_threshold_pct,
//   lock in bank_tier1_frac (default 60%) of the excess instantly — no dwell needed.
//   HWM advances by the tier-1 amount so tier-2 measures only the remainder.
//
// Tier 2 (remainder): the remaining excess is banked when either:
//   a) portfolio velocity EWMA flips negative (momentum reversal = peak has passed), or
//   b) fallback: bank_profit_dwell_min minutes have elapsed above HWM (slow uptrend).
//
// Hysteresis: dwell/tier state only resets if total_value drops >BAND below HWM
//   so CAP_TRIM fee haircuts (0.01–0.05%) don't restart the clock.
let _hwm             = 10_000.0;  // high-water mark; advances on each banking event
let _bankedProfit    = 0.0;       // cumulative real USDT extracted (alias for _lockedUsdt after first bank)
let _lockedUsdt      = 0.0;       // real USDT extracted via BANK_EXTRACT fills; permanently off-limits for new BUYs
let _initialFloor    = 0.0;       // floor at session open = capital × (1 - max_total_exposure_pct)
let _hwmCrossedAt    = null;      // when total_value first exceeded current _hwm
let _tier1Banked     = false;     // tier-1 fired for this HWM crossing?
let _lastCheckTv     = 0;         // total_value at previous check (velocity delta)
let _velocityEWMA    = 0;         // EWMA of Δtotal_value per 30s check
let _velocityWasPos  = false;     // velocity sign on previous check

const VELOCITY_ALPHA        = 0.35;  // EWMA α — halflife ~60s (2 checks), noise-resistant
const BANK_DWELL_RESET_BAND = 0.001; // 0.1% hysteresis — CAP_TRIM fees don't reset state

// Optimistic reservation — USDT/BTC committed to in-flight orders.
// Updated synchronously before each fetch so concurrent _handleIntent calls
// see the reduced available balance and don't over-commit.
// Released on fill response (success or failure).
let _reservedUsdt = 0;
let _reservedBtc  = 0;

// Post-stop-loss and post-cap-trim buy freeze — prevents patterns from re-entering
// immediately after a defensive sell, which caused cascading stop-loss cycles.
// performance.now() based (monotonic).
let _buyBlockedUntil = 0;

// Pattern-specific penalty box after stop-loss.
// Replaces the single global freeze: only the pattern that caused the SL is locked
// for stop_loss_buy_freeze_ms; other patterns (e.g. MOMENTUM_V1 while DEPTH_GRAB
// triggered the SL) can continue trading.
// Map<pattern_id, unlock_timestamp_performance_now>
const _patternPenaltyBox = new Map();

// Track which pattern_id opened the current long position (first buy fill from flat).
// Used to put the correct pattern in the penalty box when stop-loss fires.
let _openingPatternId = "";

// Stop-loss fire count for this position — resets when btc drops below 0.0001.
// The 2nd fire in a session means the market is in a genuine sustained decline;
// sell 100% to exit cleanly rather than draining slowly across multiple fires.
let _stopLossFireCount = 0;

// Post-stop-loss re-entry gate — condition-based market assessment.
// After the buy freeze expires, a time lock alone is insufficient: the market
// may still be falling. Before any new BUY is accepted the following must hold:
//   (a) livePrice ≥ _reentryMinPrice  — price has genuinely recovered above
//       the stop-loss trigger level + a configurable buffer
//   (b) _latestVpin ≤ _reentryMaxVpin — VPIN has settled; no active toxic cascade
//   (c) _priceRising                  — last two sampled prices show upward move
// All three gates must pass simultaneously. The gate is cleared when position → flat.
let _reentryMinPrice = 0;       // 0 = gate inactive; set when stop-loss fires
let _reentryMaxVpin  = 0;       // VPIN ceiling for re-entry; set when stop-loss fires
let _latestVpin      = 0;       // updated from each intent (nociceptor-computed VPIN)
let _prevLivePrice   = 0;       // one tick behind _livePrice — used for trend check

// Regime-change exit tracking
// Regime severity ordering (higher = more toxic)
const REGIME_SEVERITY     = { LowVol: 0, HighVol: 1, Crisis: 2 };
let _entryRegime          = null;    // regime when the position was first opened from flat
let _currentRegime        = "LowVol";
let _regimeExitLastAt     = 0;
const REGIME_EXIT_COOLDOWN_MS = 5 * 60_000;  // 5 min between regime-exit fires

// Vault mode: set true when guardian broadcasts vault_liquidate.
// Defence-in-depth — guardian already NACKs buys in VAULT_HOLD, but in daemon mode
// guardian and execution run in separate processes with no shared state.
let _vaultMode = false;

// Drought re-entry guard: tracks when the last BUY fill occurred.
// After a long buy-free period (post-crisis freeze, REDUCE_ONLY recovery), all
// high-aliveness patterns fire simultaneously at the same price → correlated STOP_LOSS
// cascade. Starting smaller breaks that correlation.
let _lastBuyFillAt = 0;

// Per-pair trade stats (accumulated across fills)
const _tradesByPair = {};  // symbol → { count, wins, realized_pnl }

// Cross-tab mesh exposure dampening — set from mesh_exposure_update messages
let _meshDampening = 1.0;  // > 1 = mesh is overexposed → scale Kelly down

// Macro state — updated from macro_state broadcasts
// Used for CVD soft Kelly cap (sizing reduction when fighting macro exhaustion)
let _macroState = { cvd_div: "neutral" };

// Arb-specific outcome tracking (ARBI_CROSS_EXCHANGE pattern only)
// wins/losses count only SELL closes (buys have pnl_realized=0 by definition — not a win)
let _arbWins   = 0;
let _arbLosses = 0;
let _arbOpens  = 0;   // BUY fills — open positions not yet closed
let _arbPnl    = 0.0;

// Per-pattern open BTC exposure — enforces max_pattern_exposure_pct
const _exposureByPattern = new Map();  // pattern_id → open BTC qty

function _recordTrade(symbol, pnl_realized) {
  if (!_tradesByPair[symbol]) _tradesByPair[symbol] = { count: 0, wins: 0, realized_pnl: 0 };
  _tradesByPair[symbol].count++;
  if (pnl_realized > 0) _tradesByPair[symbol].wins++;
  _tradesByPair[symbol].realized_pnl += pnl_realized;
}

function _buildPositions() {
  // BTC/USDT is the main trading pair — always included with live data.
  const btcPos = {
    coin:           _portfolio.btc,
    avg_cost:       _portfolio.avg_cost,
    realized_pnl:   _tradesByPair["BTC/USDT"]?.realized_pnl ?? _portfolio.realized_pnl,
    unrealized_pnl: _portfolio.unrealized_pnl,
    current_price:  _livePrice,
    value:          _portfolio.btc * _livePrice,
    trade_count:    _tradesByPair["BTC/USDT"]?.count ?? 0,
    wins:           _tradesByPair["BTC/USDT"]?.wins ?? 0,
  };
  const positions = { "BTC/USDT": btcPos };
  // Include any other pairs that have been traded
  for (const [symbol, stats] of Object.entries(_tradesByPair)) {
    if (symbol === "BTC/USDT") continue;
    positions[symbol] = {
      coin: 0, avg_cost: 0, unrealized_pnl: 0, current_price: 0, value: 0,
      realized_pnl: stats.realized_pnl,
      trade_count:  stats.count,
      wins:         stats.wins,
    };
  }
  return positions;
}

function _emitPortfolio() {
  const arbTotal  = _arbWins + _arbLosses;
  const btcMtmEp  = (_portfolio.btc || 0) * (_livePrice || 0);
  const tvEp      = (_livePrice > 0 && _portfolio.btc >= 0)
    ? (_portfolio.usdt || 0) + btcMtmEp
    : (_portfolio.total_value || 0);
  const floor     = _initialFloor + _lockedUsdt;
  self.postMessage({
    type:           "portfolio_update",
    ..._portfolio,
    hwm:            +_hwm.toFixed(2),
    banked_profit:  +_bankedProfit.toFixed(2),
    locked_usdt:    +_lockedUsdt.toFixed(2),
    initial_floor:  +_initialFloor.toFixed(2),
    trading_budget: +(Math.max(0, tvEp - floor)).toFixed(2),
    positions:      _buildPositions(),
    arb_wins:       _arbWins,
    arb_losses:     _arbLosses,
    arb_opens:      _arbOpens,
    arb_win_rate:   arbTotal > 0 ? +(_arbWins / arbTotal).toFixed(4) : null,
    arb_pnl:        +_arbPnl.toFixed(2),
    mesh_dampening: +_meshDampening.toFixed(3),
    timestamp:      Date.now(),
  });
}

function _successRate() {
  const total = _execSuccesses + _execFailures;
  return total > 0 ? _execSuccesses / total : 1.0;
}

function _emitStats() {
  self.postMessage({
    type:            "execution_stats",
    success_rate:    +_successRate().toFixed(4),
    is_rate_limited: Date.now() < _rateLimitUntil,
  });
}

// IndexedDB SAF queue
let _db = null;
const SAF_DB_NAME  = "echoforge_saf";
const SAF_STORE    = "queue";

self.onmessage = async (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      _phic           = { ..._phic, ...(msg.phic || {}) };
      _exchangeConfig = msg.exchange_config || null;
      if (msg.capital > 0) {
        _portfolio.usdt        = msg.capital;
        _portfolio.total_value = msg.capital;
        _hwm                   = msg.capital;
        _lastCheckTv           = msg.capital;
        _initialFloor          = msg.capital * (1 - (_phic.max_total_exposure_pct ?? 0.20));
      }
      await _openSAF();
      await _syncFromExchange();   // seed portfolio + live price from VALR (overrides above if real balance found)
      break;
    case "phic_update":
      _phic = { ..._phic, ...(msg.config || {}) };
      break;
    case "execution_intent":
      if (_isSovereign) {
        await _handleIntent(msg);
      } else {
        // Not the best-latency node — hand off to sovereign via mesh
        self.postMessage({ type: "intent_route", intent: msg });
      }
      break;
    case "routed_intent":
      // We ARE sovereign; execute on behalf of forwarding peer
      await _handleIntent(msg.intent || msg);
      break;
    case "sovereign_status":
      _isSovereign = msg.is_sovereign;
      break;
    case "saf_replay":
      await _replaySAF();
      break;
    case "sync_exchange":
      await _syncFromExchange();
      _emitPortfolio();
      break;
    case "pattern_veto":
      await _handlePatternVeto(msg);
      break;
    case "regime_change":
      _currentRegime = msg.regime_tag || msg.regime || _currentRegime;
      await _checkRegimeExit();
      break;
    case "price_tick":
      if (msg.price > 0) {
        _livePrice = msg.price;
        _checkTrailingStop();
        // Tick-driven stop-loss: fires as soon as price crosses the SL threshold
        // rather than waiting up to 30s for the polling interval.
        // _checkStopLoss() is a no-op when portfolio is flat, cooldown is active, or SL disabled.
        if (_portfolio.btc > 0.0001 && _portfolio.avg_cost > 0) _checkStopLoss();
      }
      break;
    case "guardian_set_trailing_stop":
      _trailingStopPrice = msg.price || 0;
      break;
    case "guardian_clear_trailing_stop":
      _trailingStopPrice = 0;
      break;
    case "tab_hidden":
      _tabFreeze = true;
      break;
    case "tab_visible":
      _tabFreeze = false;
      break;
    case "ping":
      self.postMessage({ type: "pong", ts: msg.ts });
      break;
    case "network_status":
      _online = msg.online;
      if (_online) await _replaySAF();
      break;
    case "cashout":
      await _handleCashout();
      break;
    case "mesh_exposure_update": {
      const maxPct  = _phic.max_total_exposure_pct ?? 0.20;
      const trigger = maxPct * 0.7;  // dampen when mesh exceeds 70% of cap
      _meshDampening = msg.meshExposure > trigger
        ? Math.max(1.0, msg.meshExposure / trigger)
        : 1.0;
      break;
    }
    case "macro_state":
    case "macro_state_partial":
      // Merge CVD divergence field; other macro fields handled in nociceptor/guardian
      if (msg.cvd_div != null) _macroState.cvd_div = msg.cvd_div;
      break;
    case "vault_liquidate":
      _vaultMode = true;
      if (_portfolio.btc > 0.0001 && !_phic.emergency_freeze && _livePrice > 0) {
        const _vaultQty = +_portfolio.btc.toFixed(6);
        console.warn(`[execution] vault_liquidate — full position sell qty=${_vaultQty}`);
        await _submitOrder({
          pattern_id:      "VAULT_SWEEP",
          side:            "sell",
          symbol:          "BTC/USDT",
          quantity:        _vaultQty,
          type:            "VAULT_SWEEP",
          bypass_hurdles:  true,
        });
      }
      break;
    case "vault_cleared":
      _vaultMode = false;
      break;
  }
};

async function _handleIntent(intent) {
  if (_tabFreeze) return;  // backgrounded tab — stale prices, throttled timers; block all new orders
  if (_phic.emergency_freeze) return;
  if (_vaultMode && intent.direction === "buy") return;  // defence-in-depth: guardian already NACKs in VAULT_HOLD
  if (performance.now() < _rateLimitUntil) return;  // monotonic rate-limit check

  const { pattern_id, net_aliveness, regime_tag, direction } = intent;

  // Sync live price from main thread's real market price (Binance stream or synthetic)
  if (intent.market_price > 0) {
    _prevLivePrice = _livePrice > 0 ? _livePrice : intent.market_price;
    _livePrice = intent.market_price;
  }
  // Track latest VPIN for re-entry assessment
  if (typeof intent.vpin === "number" && intent.vpin > 0) _latestVpin = intent.vpin;

  // Gate all execution until a real price has arrived — never trade on a stale seed
  if (_livePrice === 0) return;

  // Per-pattern cooldown — arb signals are time-critical so use a tighter window
  // performance.now() used for interval math — immune to NTP/DST clock jumps
  const lastTrade  = _patternLastTrade.get(pattern_id) || 0;
  const cooldownMs = pattern_id === "ARBI_CROSS_EXCHANGE" ? ARB_COOLDOWN_MS : PATTERN_COOLDOWN_MS;
  if (performance.now() - lastTrade < cooldownMs) return;

  const side = direction || "buy";

  // Post-stop-loss / post-cap-trim buy freeze — defensive sells must not be immediately
  // reversed by pattern re-entry; this is the primary guard against cascading stop-loss cycles.
  if (side === "buy" && performance.now() < _buyBlockedUntil) return;

  // Pattern-specific penalty box: if this pattern caused a stop-loss, it is frozen
  // for the full stop_loss_buy_freeze_ms window — independent of other patterns.
  if (side === "buy") {
    const penaltyUntil = _patternPenaltyBox.get(pattern_id);
    if (penaltyUntil != null) {
      if (performance.now() < penaltyUntil) return;
      _patternPenaltyBox.delete(pattern_id);  // penalty expired — remove so map stays clean
    }
  }

  // Post-stop-loss re-entry gate — after the time freeze lifts, require market confirmation
  // before accepting any new BUY. All three conditions must hold simultaneously:
  //   (a) price has recovered above the stop-trigger + buffer
  //   (b) VPIN has settled below the toxic threshold
  //   (c) price is moving upward (prev tick < current tick)
  if (side === "buy" && _reentryMinPrice > 0) {
    const priceOk   = _livePrice >= _reentryMinPrice;
    const vpinOk    = _reentryMaxVpin <= 0 || _latestVpin <= _reentryMaxVpin;
    const trendOk   = _prevLivePrice <= 0 || _livePrice > _prevLivePrice;
    if (!priceOk || !vpinOk || !trendOk) return;
    // All conditions met — clear the gate so we don't re-check on every subsequent intent
    _reentryMinPrice = 0;
    console.info(`[re-entry] gate cleared: price=${_livePrice.toFixed(2)} vpin=${_latestVpin.toFixed(3)} trend=${_livePrice > _prevLivePrice ? "up" : "flat"}`);
  }

  // DCA guard: a buy while we're already underwater is not a reaction — it must be a
  // deliberate intent with positive expected payoff.
  // Averaging down mechanically into a falling price compounds losses; any pattern that
  // wants to buy while the position is losing must prove high conviction (aliveness ≥
  // dca_aliveness_floor) OR be an explicit spread-arbitrage with a guaranteed payoff edge.
  if (side === "buy" && _portfolio.btc > 0.0001 && _portfolio.avg_cost > 0 && _livePrice < _portfolio.avg_cost) {
    const underwaterPct    = (_portfolio.avg_cost - _livePrice) / _portfolio.avg_cost * 100;
    const dcaFloor         = _phic.dca_aliveness_floor ?? 0.80;
    const isArbi           = pattern_id === "ARBI_CROSS_EXCHANGE";
    const hasPayoff        = isArbi || (intent.net_aliveness != null && intent.net_aliveness >= dcaFloor);
    if (!hasPayoff) {
      console.info(`[dca-guard] DROP ${pattern_id} underwater=${underwaterPct.toFixed(2)}% aliveness=${(intent.net_aliveness??0).toFixed(2)} floor=${dcaFloor}`);
      return;
    }
    if (isArbi) {
      console.info(`[dca-guard] ALLOW ARBI (spread payoff) underwater=${underwaterPct.toFixed(2)}%`);
    }
  }

  // Available balance = total minus in-flight reservations and permanently locked banked profits
  const availUsdt = Math.max(0, _portfolio.usdt - _reservedUsdt - _lockedUsdt);
  const availBtc  = Math.max(0, _portfolio.btc  - _reservedBtc);

  // Enforce position sanity using available (not total) balance
  if (side === "buy"  && availUsdt < 10)     return;
  if (side === "sell" && availBtc  < 0.0001) return;

  // Enforce per-pattern exposure cap (prevents one pattern monopolising the position)
  if (side === "buy" && _phic.max_pattern_exposure_pct > 0) {
    const patternBtc    = _exposureByPattern.get(pattern_id) || 0;
    const totalVal      = _portfolio.total_value || 10_000;
    const patternExpPct = (patternBtc * (_livePrice || 1)) / totalVal;
    if (patternExpPct >= _phic.max_pattern_exposure_pct) {
      self.postMessage({ type: "order_failed", pattern_id,
        error: `pattern cap: ${(patternExpPct * 100).toFixed(1)}% ≥ ${(_phic.max_pattern_exposure_pct * 100).toFixed(0)}%`,
        timestamp: Date.now() });
      return false;
    }
  }

  // Enforce aggregate total exposure cap (all patterns combined — prevents correlated accumulation)
  if (side === "buy") {
    const maxTotalPct = _phic.max_total_exposure_pct ?? 0.20;
    if (maxTotalPct > 0) {
      const totalVal    = _portfolio.total_value || 10_000;
      // effectiveBtc = current BTC minus in-flight sells PLUS in-flight buys (converted from USDT).
      // Without the pending-buy term, concurrent BUY intents all see 0% exposure and all pass,
      // causing correlated position accumulation before any fills arrive.
      const pendingBuyBtc  = (_livePrice > 0) ? (_reservedUsdt / _livePrice) : 0;
      const effectiveBtc   = Math.max(0, _portfolio.btc - (_reservedBtc || 0)) + pendingBuyBtc;
      const totalExpPct    = (effectiveBtc * (_livePrice || 1)) / totalVal;
      if (totalExpPct >= maxTotalPct) {
        self.postMessage({ type: "order_failed", pattern_id,
          error: `total cap: ${(totalExpPct * 100).toFixed(1)}% ≥ ${(maxTotalPct * 100).toFixed(0)}%`,
          timestamp: Date.now() });
        // Active trim: sell excess whenever we're >1% over the cap, at most once per minute
        _maybeCapTrim(maxTotalPct, totalVal);
        return false;
      }
    }
  }

  const auto       = Math.max(0.01, Math.min(1.0, _phic.autonomy_level || 0.5));
  const posPct     = Math.max(0.001, Math.min(1.0, (_phic.max_position_pct || 1.0) / 100));
  // Conviction scale: high-aliveness patterns get proportionally larger allocations
  const conviction = Math.pow(Math.max(0.1, Math.min(1.0, net_aliveness ?? 0.5)), 2.0);

  // Fractional Kelly with payoff ratio: f* = (p·b − (1−p)) / b
  // b is the expected win/loss size ratio (default 1.5 — winners average 1.5× losers in BTC).
  // This is the proper Kelly formula; the prior ad-hoc (p−0.5)/(1−p) ignored b entirely.
  if (intent.p_up_fallback && (net_aliveness ?? 0) > 0.70) {
    console.warn(`[exec] jury cache stale for high-conviction echo (aliveness=${(net_aliveness ?? 0).toFixed(2)}) — sizing at fallback p_up=0.55`);
  }
  const pUp        = Math.max(0.50, Math.min(0.95, intent.p_up || 0.55));
  const b          = Math.max(1.0, _phic.kelly_payoff_ratio ?? 1.5);
  const kellyRaw   = (pUp * b - (1 - pUp)) / b;
  const kelly      = Math.max(0.05, Math.min(0.40, kellyRaw));  // cap at 40% Kelly

  // Size from available (not total) balance so concurrent orders don't over-commit.
  // For strong sell signals when the position is underwater: floor conviction × kelly so that
  // even near-dead patterns sell a meaningful fraction rather than the 0.0001 BTC minimum.
  const isStrongBearSell = side === "sell"
    && (intent.net_alpha ?? 0) < -0.005
    && (intent.unrealized_pnl_norm ?? 0) < -0.003;
  const sellFloor = isStrongBearSell ? Math.max(conviction * kelly, 0.15) : conviction * kelly;

  let qty = side === "buy"
    ? (availUsdt * auto * posPct * conviction * kelly) / (_livePrice * _meshDampening)
    : (availBtc  * auto * posPct * sellFloor);

  // Exposure headroom cap: clamp BUY qty so this order cannot push total exposure past
  // max_total_exposure_pct. The pre-check at line 465 blocks when already at/above cap
  // but the last order in a wave can overshoot (check saw 19.7% < 20%, order adds 3% → 22.7%).
  if (side === "buy" && _livePrice > 0) {
    const maxTotalPct  = _phic.max_total_exposure_pct ?? 0.20;
    const totalVal     = _portfolio.total_value || 10_000;
    const pendingBtc   = _reservedUsdt / _livePrice;
    const currentBtc   = Math.max(0, _portfolio.btc - (_reservedBtc || 0)) + pendingBtc;
    const headroomBtc  = Math.max(0, (maxTotalPct * totalVal / _livePrice) - currentBtc);
    qty = Math.min(qty, headroomBtc);
  }

  // Arb: size proportionally to observed lag (bigger lag = higher confidence); cap at 0.1 BTC
  if (pattern_id === "ARBI_CROSS_EXCHANGE") {
    const lagMs   = intent.exchange_lag_ms ?? 15;
    const lagScale = Math.min(2.0, Math.max(0.3, lagMs / 50));
    qty = Math.min(qty * lagScale, 0.1);
  }

  // Regime cap — scale BUY size by the per-regime fraction; sells are never capped (exits must be free)
  if (side === "buy") {
    const regimeCap = Math.min(1.0, intent.regime_cap ?? Infinity);
    qty *= regimeCap;
  }

  // CVD macro soft cap — reduce size when fighting macro exhaustion signal.
  // Routing this here (not via Guardian) keeps it as a soft sizing modifier, not a state transition.
  // Friction Point 4 fix: Guardian's Kelly sizing math lives here, not in guardian_worker.js.
  if (_phic.macro_enabled !== false) {
    if (_macroState.cvd_div === "bearish_div" && side === "buy")  qty *= 0.60;
    if (_macroState.cvd_div === "bullish_div" && side === "sell") qty *= 0.60;
  }

  // Guardian size multiplier — applied last, composites VPIN + house money
  const guardianMult = intent._guardian_size_mult ?? 1.0;
  if (guardianMult < 0.999) qty = Math.max(0.0001, qty * guardianMult);

  // Drought re-entry guard: after a long buy-free period, start smaller.
  // Prevents all high-aliveness patterns firing full-size at the same price on
  // post-freeze re-entry OR session open, which creates correlated positions
  // → correlated STOP_LOSS cascade. _lastBuyFillAt===0 means session start (never
  // bought before in this session), which is treated as an infinite drought.
  if (side === "buy") {
    const droughtThreshMs = (_phic.drought_threshold_min ?? 5) * 60_000;
    const timeSinceLastBuy = _lastBuyFillAt > 0 ? Date.now() - _lastBuyFillAt : Infinity;
    if (timeSinceLastBuy > droughtThreshMs) {
      const droughtMult = _phic.drought_reentry_size ?? 0.50;
      qty = Math.max(0.0001, qty * droughtMult);
    }
  }

  const order = {
    pattern_id,
    symbol:      _exchangeConfig?.symbol || "BTC/USDT",
    side,
    quantity:    Math.max(0.0001, +qty.toFixed(6)),
    limit_price: 0,
    regime_tag,
    created_at:  Date.now(),
  };

  if (!_online) {
    await _enqueueSAF(order, "offline");
    return;
  }

  // Reserve balance optimistically — synchronous, so the next _handleIntent call
  // (which runs while this one is awaiting the fetch) sees the reduced available balance
  const reservedCost = order.quantity * _livePrice;
  if (side === "buy")  _reservedUsdt += reservedCost;
  else                 _reservedBtc  += order.quantity;

  const ok = await _submitOrder(order);

  // Release reservation regardless of outcome — portfolio already updated from fill response
  if (side === "buy")  _reservedUsdt = Math.max(0, _reservedUsdt - reservedCost);
  else                 _reservedBtc  = Math.max(0, _reservedBtc  - order.quantity);

  return ok;
}

async function _submitOrder(order) {
  if (!_exchangeConfig?.api_url) {
    self.postMessage({ type: "order_failed", pattern_id: order.pattern_id, error: "no exchange config" });
    return false;
  }

  // Route to market or limit endpoint based on whether a limit price was given.
  const endpoint = (order.limit_price && order.limit_price > 0)
    ? "/v1/orders/limit"
    : "/v1/orders/market";

  try {
    const resp = await fetch(_exchangeConfig.api_url + endpoint, {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-API-Key":       _exchangeConfig.api_key || "",
      },
      body: JSON.stringify(order),
    });

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "5");
      _rateLimitUntil = performance.now() + retryAfter * 1000;  // monotonic — immune to NTP jumps
      await _enqueueSAF(order, "rate_limited");
      return false;
    }

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${err}`);
    }

    const result  = await resp.json();
    const orderId = result.id || result.order_id || "unknown";

    // Update local portfolio mirror and live price reference
    if (result.portfolio) Object.assign(_portfolio, result.portfolio);
    if (result.filled_price > 0) _livePrice = result.filled_price;

    // Record trade time for per-pattern cooldown (monotonic, matches the performance.now() check above)
    _patternLastTrade.set(order.pattern_id, performance.now());

    self.postMessage({
      type:          "order_submitted",
      pattern_id:    order.pattern_id,
      regime_tag:    order.regime_tag,
      order_id:      orderId,
      symbol:        order.symbol,
      side:          result.side || order.side,
      qty:           result.filled_qty ?? order.quantity,
      filled_price:  result.filled_price ?? 0,
      pnl_realized:  result.pnl_realized ?? 0,
      portfolio:     result.portfolio ?? null,
      timestamp:     Date.now(),
    });

    _emitPortfolio();

    // Update per-pattern BTC exposure for concentration tracking
    const filledQty = result.filled_qty ?? order.quantity;
    if (order.side === "buy") {
      _exposureByPattern.set(order.pattern_id, (_exposureByPattern.get(order.pattern_id) || 0) + filledQty);
      _lastBuyFillAt = Date.now();  // used by drought re-entry guard in Kelly sizing
      // Record regime at first entry — regime-change exit uses this to detect degradation
      if (!_entryRegime) _entryRegime = order.regime_tag || _currentRegime;
      // Record the opening pattern (only the first buy from flat — subsequent adds don't change it).
      // Used to penalize the correct pattern when stop-loss fires.
      if (!_openingPatternId) _openingPatternId = order.pattern_id;
    } else if (order.pattern_id === "CAP_TRIM" || order.pattern_id === "STOP_LOSS" || order.pattern_id === "REGIME_EXIT") {
      // Aggregate sell: realign all pattern exposures to the actual portfolio BTC.
      // These sells don't belong to any pattern so we can't deduct from one — instead
      // scale every pattern's tracked exposure proportionally so the map sum matches
      // the real position. This fixes the bug where REVERSION_A/SPREAD_FADE exposures
      // accumulate unboundedly while CAP_TRIM sells reduce the actual position.
      const actualBtc = _portfolio.btc ?? 0;
      const totalTracked = [..._exposureByPattern.values()].reduce((s, v) => s + v, 0);
      if (totalTracked > 0 && actualBtc >= 0) {
        const scale = actualBtc / totalTracked;
        for (const [pid, qty] of _exposureByPattern) {
          _exposureByPattern.set(pid, qty * scale);
        }
      }
    } else {
      const cur = _exposureByPattern.get(order.pattern_id) || 0;
      _exposureByPattern.set(order.pattern_id, Math.max(0, cur - filledQty));
    }
    // When total BTC position reaches zero, all pattern exposures are gone
    if ((_portfolio.btc ?? 0) < 0.0001) {
      _exposureByPattern.clear();
      _reservedBtc        = 0;
      _entryRegime        = null;  // position flat — reset for next entry
      _openingPatternId   = "";    // reset opening pattern — next buy gets a fresh attribution
      _stopLossFireCount  = 0;     // reset so next position gets a fresh first fire
      _reentryMinPrice    = 0;     // clear re-entry gate — no position to protect
      _reentryMaxVpin     = 0;
    }

    const pnlRaw = result.pnl_realized ?? 0;

    _recordTrade(order.symbol || "BTC/USDT", pnlRaw);
    if (order.pattern_id === "ARBI_CROSS_EXCHANGE") {
      _arbPnl += pnlRaw;
      if (result.side === "sell") {
        if (pnlRaw >= 0) _arbWins++; else _arbLosses++;
        _arbOpens = Math.max(0, _arbOpens - 1);
      } else {
        _arbOpens++;
      }
    }
    _execSuccesses++;
    _emitStats();

    // Only emit execution_result for SELL fills (round-trip close).
    // BUY fills have pnl_realized=0 by definition — scoring +0.15 on every buy
    // permanently inflated Beta-Bernoulli win counts so losing patterns appeared
    // half-reliable. The bridge updates aliveness only on closed-trade outcomes.
    if (result.side === "sell") {
      // pnl_realized from exchange is gross (avg_cost does not include buy-side fee).
      // Subtract round-trip taker fees so a break-even gross trade scores negative —
      // the system must clear fees to register as a win.
      const grossValue   = (result.filled_price || _livePrice) * (result.filled_qty ?? 0.001);
      const takerFee     = _exchangeConfig?.taker_fee ?? 0.001;
      const pnlNet       = pnlRaw - grossValue * takerFee * 2;
      const refSize      = grossValue * 0.01;
      const outcomeScore = Math.max(-1, Math.min(1, pnlNet / Math.max(refSize, 0.001)));
      self.postMessage({ type: "execution_result", pattern_id: order.pattern_id, outcome_score: outcomeScore, regime_tag: order.regime_tag, direction: "sell" });
    }
    return true;

  } catch (err) {
    _execFailures++;
    _emitStats();
    self.postMessage({ type: "order_failed", pattern_id: order.pattern_id, error: err.message, timestamp: Date.now() });
    await _enqueueSAF(order, err.message);  // no-op during replay (_replaying guard)
    self.postMessage({ type: "execution_result", pattern_id: order.pattern_id, outcome_score: -0.5, regime_tag: order.regime_tag });
    return false;
  }
}

// ── Cap overage trim — PROFIT ONLY ────────────────────────────────────────
// Called when a buy is rejected by the total exposure cap.
// Only trims when the position is in profit (unrealized_pnl > 0) — this turns
// CAP_TRIM into a profit-extraction mechanism rather than a forced loss event.
// When the position is underwater, CAP_TRIM is suppressed and STOP_LOSS handles risk.
// The extracted profit is explicitly banked into _bankedProfit (capital floor).
// Throttled to once per 3 min to avoid sell churn.
let _capTrimLastAt = 0;
const CAP_TRIM_COOLDOWN_MS = 180_000;
const CAP_TRIM_TARGET      = 0.70;    // trim to 70% of cap, leaving room for ~1 buy

async function _maybeCapTrim(maxTotalPct, totalVal) {
  const now = Date.now();
  if (now - _capTrimLastAt < CAP_TRIM_COOLDOWN_MS) return;
  if (!_exchangeConfig?.api_url || _livePrice === 0 || _portfolio.btc < 0.0001) return;

  const totalExpPct = (_portfolio.btc * _livePrice) / totalVal;
  if (totalExpPct <= maxTotalPct + 0.002) return;

  // Profit gate: only trim if the position has unrealized gains to extract.
  // If underwater, do not force a loss — let STOP_LOSS manage that path.
  const unrealPnl = _portfolio.unrealized_pnl ?? 0;
  if (unrealPnl <= 0) {
    self.postMessage({
      type:      "cap_trim_notification",
      trim_btc:  0,
      total_exp: +totalExpPct.toFixed(4),
      price:     _livePrice,
      skipped:   true,
      reason:    "position_underwater",
      timestamp: now,
    });
    return;
  }

  _capTrimLastAt = now;
  const capFreeze = _phic.cap_trim_buy_freeze_ms ?? 180_000;
  _buyBlockedUntil = Math.max(_buyBlockedUntil, performance.now() + capFreeze);

  const targetBtc = (maxTotalPct * CAP_TRIM_TARGET * totalVal) / _livePrice;
  const trimBtc   = Math.max(0.0001, +(_portfolio.btc - targetBtc).toFixed(6));

  // Bank the profit: estimate how much of the trim represents profit above avg_cost.
  // This goes into _bankedProfit as a capital floor so it isn't recycled immediately.
  const avgCost = _portfolio.avg_cost || _livePrice;
  const profitPerBtc = Math.max(0, _livePrice - avgCost);
  const estimatedProfit = profitPerBtc * trimBtc;
  if (estimatedProfit > 0) {
    _lockedUsdt   += estimatedProfit;  // CAP_TRIM is a real sell — the profit is genuine USDT
    _bankedProfit += estimatedProfit;
    _hwm = Math.max(_hwm, totalVal);   // advance HWM to lock in the gain
    self.postMessage({
      type:          "profit_banked",
      source:        "CAP_TRIM",
      amount_banked: +estimatedProfit.toFixed(2),
      total_banked:  +_bankedProfit.toFixed(2),
      locked_usdt:   +_lockedUsdt.toFixed(2),
      new_hwm:       +_hwm.toFixed(2),
      timestamp:     now,
    });
  }

  await _submitOrder({
    pattern_id:  "CAP_TRIM",
    symbol:      _exchangeConfig.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    +Math.min(trimBtc, _portfolio.btc).toFixed(6),
    limit_price: 0,
    regime_tag:  "LowVol",
    created_at:  now,
  });
  self.postMessage({
    type:      "cap_trim_notification",
    trim_btc:  +trimBtc.toFixed(6),
    total_exp: +totalExpPct.toFixed(4),
    price:     _livePrice,
    skipped:   false,
    profit_extracted: +estimatedProfit.toFixed(2),
    timestamp: now,
  });
}

// ── Cashout — flatten all open BTC positions immediately ──────────────────
async function _handleCashout() {
  if (_portfolio.btc < 0.0001) {
    self.postMessage({
      type: "cashout_complete", reason: "no_position",
      btc: 0, usdt: _portfolio.usdt, pnl: 0, timestamp: Date.now(),
    });
    return;
  }
  const qty = +_portfolio.btc.toFixed(6);
  const order = {
    pattern_id:  "CASHOUT",
    symbol:      _exchangeConfig?.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    qty,
    limit_price: 0,  // market order
    regime_tag:  "LowVol",
    created_at:  Date.now(),
  };
  await _submitOrder(order);
  // _submitOrder emits order_submitted; emit cashout_complete so the main thread can show PnL
  self.postMessage({
    type:      "cashout_complete",
    reason:    "flattened",
    btc_sold:  qty,
    usdt:      _portfolio.usdt,
    pnl:       _portfolio.realized_pnl,
    timestamp: Date.now(),
  });
}

// ── Graceful kill (quorum veto) ────────────────────────────────────────────
// When the mesh reaches consensus that a pattern is irreparably broken, flatten
// any open position and free the capital before marking the echo dead.
async function _handlePatternVeto(msg) {
  const { pattern_id, regime_tag, cause } = msg;

  // Remove from cooldown map so it doesn't linger
  _patternLastTrade.delete(pattern_id);

  // If we're holding BTC (could be an open position from this pattern),
  // submit a market sell to flatten inventory before the pattern goes dark.
  if (_portfolio.btc > 0.0001 && _exchangeConfig?.api_url) {
    const flattenOrder = {
      pattern_id,
      symbol:      _exchangeConfig.symbol || "BTC/USDT",
      side:        "sell",
      quantity:    +_portfolio.btc.toFixed(6),
      limit_price: 0,
      regime_tag,
      created_at:  Date.now(),
    };
    try {
      await _submitOrder(flattenOrder);
    } catch (_) {
      // Best-effort — log via order_failed already handles the error path
    }
  }

  self.postMessage({
    type:       "veto_complete",
    pattern_id,
    regime_tag,
    cause,
    timestamp:  Date.now(),
  });
}

// ── Exchange sync ─────────────────────────────────────────────────────────
// Fetches balances and current mid-price from VALR so the local mirror is
// always seeded from the real source of truth, not hardcoded defaults.

async function _syncFromExchange() {
  if (!_exchangeConfig?.api_url) return;
  const headers = { "X-API-Key": _exchangeConfig.api_key || "" };
  try {
    const balRes = await fetch(_exchangeConfig.api_url + "/v1/account/balances", { headers });
    if (balRes.ok) {
      const bal = await balRes.json();
      Object.assign(_portfolio, bal);
      // Exchange gave us ground-truth balances — clear any stale reservations
      _reservedUsdt = 0;
      _reservedBtc  = 0;
      // Seed HWM from exchange total_value on first sync (or if exchange shows higher value)
      if ((_portfolio.total_value || 0) > _hwm) {
        _hwm = _portfolio.total_value;
        _hwmCrossedAt = null;
      }
    }
  } catch (_) {}
  try {
    const obRes = await fetch(_exchangeConfig.api_url + "/v1/marketdata/BTCUSDT/orderbook", { headers });
    if (obRes.ok) {
      const ob   = await obRes.json();
      const bid  = parseFloat(ob.Bids?.[0]?.price || 0);
      const ask  = parseFloat(ob.Asks?.[0]?.price || 0);
      if (bid > 0 && ask > 0) _livePrice = (bid + ask) / 2;
      else if (bid > 0)       _livePrice = bid;
      else if (ask > 0)       _livePrice = ask;
    }
  } catch (_) {}
}

// ── SAF (IndexedDB) ────────────────────────────────────────────────────────

async function _openSAF() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SAF_DB_NAME, 1);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(SAF_STORE)) {
        const store = db.createObjectStore(SAF_STORE, { keyPath: "entry_id" });
        store.createIndex("status", "status");
        store.createIndex("queued_at", "queued_at");
      }
    };
    req.onsuccess = (ev) => { _db = ev.target.result; resolve(); };
    req.onerror   = (ev) => reject(ev.target.error);
  });
}

async function _enqueueSAF(order, reason) {
  if (!_db || _replaying) return;   // never re-enqueue during replay — just emit order_failed
  const entry = {
    entry_id:   crypto.randomUUID(),
    status:     "PENDING",
    retry_count: 0,
    reason,
    queued_at:  Date.now(),
    expires_at: Date.now() + 300_000,  // 5 min TTL
    ...order,
  };
  await new Promise((resolve, reject) => {
    const tx    = _db.transaction(SAF_STORE, "readwrite");
    const store = tx.objectStore(SAF_STORE);
    const req   = store.add(entry);
    req.onsuccess = resolve;
    req.onerror   = () => reject(req.error);
  });
  self.postMessage({ type: "saf_queued", pattern_id: order.pattern_id, entry_id: entry.entry_id });
  _updateSAFStatus();
}

async function _replaySAF() {
  if (!_db || !_online || _replaying) return;
  _replaying = true;
  const now  = Date.now();
  const all  = await _getAllPending();
  let count  = 0;

  for (const entry of all) {
    const retries = (entry.retry_count || 0);
    if (entry.expires_at < now || retries >= SAF_MAX_RETRIES) {
      await _updateSAFEntry(entry.entry_id, { status: "EXPIRED" });
      continue;
    }
    const ok = await _submitOrder(entry);
    if (ok) {
      await _updateSAFEntry(entry.entry_id, { status: "SUBMITTED" });
      count++;
    } else {
      // Put back as PENDING with incremented retry count so it tries again next cycle
      await _updateSAFEntry(entry.entry_id, { retry_count: retries + 1 });
    }
  }

  _replaying = false;
  _updateSAFStatus();
  return count;
}

// ── Regime-change exit ────────────────────────────────────────────────────────
// When regime worsens after entry (LowVol→HighVol, *→Crisis), exit proportionally.
// Exits BEFORE the price move, not after — making this a leading signal vs. the
// lagging price-based stop-loss. Sell fraction scales with severity of the jump.
async function _checkRegimeExit() {
  if (_phic.emergency_freeze) return;
  if (!_exchangeConfig?.api_url || _livePrice === 0 || (_portfolio.btc ?? 0) < 0.0001) return;
  if (!_entryRegime) return;
  if (Date.now() - _regimeExitLastAt < REGIME_EXIT_COOLDOWN_MS) return;

  const entrySev = REGIME_SEVERITY[_entryRegime]  ?? 0;
  const nowSev   = REGIME_SEVERITY[_currentRegime] ?? 0;
  const jump     = nowSev - entrySev;
  if (jump <= 0) return;  // regime same or improving — hold

  // Sell fraction scales with severity:
  //   LowVol→HighVol (+1): 30% — mild hedge, informed flow entering but not panic
  //   HighVol→Crisis  (+1): 50% — meaningful exit, toxicity spiking past what we entered
  //   LowVol→Crisis   (+2): 70% — aggressive exit, regime skipped HighVol entirely
  const sellFrac = jump >= 2 ? 0.70 : (entrySev === 0 ? 0.30 : 0.50);
  const now      = Date.now();
  _regimeExitLastAt = now;

  const sellQty = +Math.max(0.0001, (_portfolio.btc * sellFrac).toFixed(6));
  await _submitOrder({
    pattern_id:  "REGIME_EXIT",
    symbol:      _exchangeConfig.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    Math.min(sellQty, _portfolio.btc),
    limit_price: 0,
    regime_tag:  _currentRegime,
    created_at:  now,
  });

  self.postMessage({
    type:        "regime_exit_fired",
    from_regime: _entryRegime,
    to_regime:   _currentRegime,
    sell_frac:   sellFrac,
    btc_before:  +(_portfolio.btc).toFixed(6),
    timestamp:   now,
  });

  // Advance entry regime to current so a further deterioration can still trigger
  _entryRegime = _currentRegime;
}

// ── Portfolio-level stop-loss ──────────────────────────────────────────────
// Fires when price drops stop_loss_pct% below the avg_cost of the held position.
// Sells STOP_LOSS_SELL_FRAC of the position — meaningful exit, not a full flatten
// (leaves room for recovery while cutting the tail risk).
// Cooldown prevents sell thrashing on noisy micro-bounces.
let _stopLossLastAt = 0;
const STOP_LOSS_COOLDOWN_MS = 120_000;  // 2 min between stop-loss fires
const STOP_LOSS_SELL_FRAC   = 0.50;     // sell half on first breach; repeat after cooldown if still underwater

async function _checkStopLoss() {
  if (_phic.emergency_freeze) return;
  if (!_exchangeConfig?.api_url || _livePrice === 0 || _portfolio.btc < 0.0001) return;
  if (!(_portfolio.avg_cost > 0)) return;

  const stopLossPct = _phic.stop_loss_pct ?? 2.5;
  if (stopLossPct <= 0) return;  // 0 = disabled

  const priceDropPct = (_portfolio.avg_cost - _livePrice) / _portfolio.avg_cost * 100;
  if (priceDropPct < stopLossPct) return;

  const now = performance.now();  // monotonic for cooldown interval
  if (now - _stopLossLastAt < STOP_LOSS_COOLDOWN_MS) return;
  _stopLossLastAt = now;

  // Pattern-specific penalty box: freeze only the pattern that opened this position
  // for the full stop_loss_buy_freeze_ms window. Other patterns can still buy.
  // A short global freeze (60s) protects against immediate re-entry from any pattern.
  const buyFreeze = _phic.stop_loss_buy_freeze_ms ?? 600_000;
  if (_openingPatternId) {
    _patternPenaltyBox.set(_openingPatternId, now + buyFreeze);
    console.info(`[stop-loss] pattern ${_openingPatternId} in penalty box for ${(buyFreeze/60000).toFixed(0)} min`);
  }
  _buyBlockedUntil = Math.max(_buyBlockedUntil, now + 60_000);  // 60s global cool-off for all patterns

  // Set the condition-based re-entry gate that activates when the time freeze lifts.
  // Requires: price recovered above stop trigger + buffer, VPIN settled, price rising.
  const stopTriggerPrice  = _portfolio.avg_cost * (1 - stopLossPct / 100);
  const reentryBuffer     = _phic.stop_loss_reentry_buffer ?? 0.010; // default 1% above trigger
  _reentryMinPrice        = stopTriggerPrice * (1 + reentryBuffer);
  _reentryMaxVpin         = _phic.vpin_highvol_threshold ?? 0.40;
  console.info(`[stop-loss] re-entry gate set: minPrice=${_reentryMinPrice.toFixed(2)} maxVpin=${_reentryMaxVpin.toFixed(2)}`);

  // Escalating sell fraction: configured fraction on first fire; 100% on all subsequent fires.
  // "2nd stop-loss = market is in genuine sustained decline; exit cleanly."
  _stopLossFireCount++;
  const baseFrac  = Math.max(0.25, Math.min(1.0, _phic.stop_loss_sell_frac ?? STOP_LOSS_SELL_FRAC));
  const sellFrac  = _stopLossFireCount > 1 ? 1.0 : baseFrac;
  console.info(`[stop-loss] fire#${_stopLossFireCount} drop=${priceDropPct.toFixed(2)}% sellFrac=${sellFrac} buyFreeze=${(buyFreeze/60000).toFixed(1)}min`);
  const sellQty = +Math.max(0.0001, (_portfolio.btc * sellFrac).toFixed(6));
  await _submitOrder({
    pattern_id:  "STOP_LOSS",
    symbol:      _exchangeConfig.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    Math.min(sellQty, _portfolio.btc),
    limit_price: 0,
    regime_tag:  "LowVol",
    created_at:  now,
  });
  // Notify Guardian immediately so the SL circuit breaker can enforce before the
  // next execution_intent arrives. Guardian must not wait for execution_result.
  self.postMessage({
    type:       "stop_loss_notification",
    pattern_id: _openingPatternId || "STOP_LOSS",
    fire_count: _stopLossFireCount,
    sell_frac:  sellFrac,
    drop_pct:   +priceDropPct.toFixed(2),
    price:      _livePrice,
    timestamp:  Date.now(),
  });
}

// ── Guardian trailing stop ────────────────────────────────────────────────────
async function _checkTrailingStop() {
  if (_trailingStopPrice <= 0 || _livePrice <= 0 || _portfolio.btc < 0.0001) return;
  if (_phic.emergency_freeze) return;
  if (_livePrice >= _trailingStopPrice) return;  // price still above stop

  const sellQty = +Math.max(0.0001, (_portfolio.btc * 0.5).toFixed(6));
  _trailingStopPrice = 0;  // one-shot — clear before submit to prevent double-fire
  await _submitOrder({
    pattern_id:  "GUARDIAN_TRAIL",
    symbol:      _exchangeConfig?.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    Math.min(sellQty, _portfolio.btc),
    limit_price: 0,
    regime_tag:  "LowVol",
    created_at:  Date.now(),
  });
}

// ── Profit banking (two-tier velocity-aware — real USDT extraction) ──────
// Banking submits a real market SELL (BANK_EXTRACT) so profit is only credited
// once the exchange confirms the fill. _lockedUsdt grows with each confirmed fill
// and is subtracted from availUsdt, so banked USDT can never be re-deployed.
async function _checkBankProfits() {
  if (!(_phic.bank_extract_enabled ?? true)) return;  // paper/debug: skip real sells
  if (_livePrice <= 0) return;

  const btcMtm = (_portfolio.btc || 0) * _livePrice;
  const tv = (_portfolio.btc >= 0)
    ? (_portfolio.usdt || 0) + btcMtm
    : (_portfolio.total_value || 0);
  if (tv <= 0 || _hwm <= 0) return;

  // Velocity tracking — EWMA of Δtotal_value between 30s checks
  const delta       = _lastCheckTv > 0 ? tv - _lastCheckTv : 0;
  _lastCheckTv      = tv;
  _velocityEWMA     = _velocityEWMA * (1 - VELOCITY_ALPHA) + delta * VELOCITY_ALPHA;
  const velPos      = _velocityEWMA > 0;
  const velReversal = _velocityWasPos && !velPos;   // positive→non-positive flip
  _velocityWasPos   = velPos;

  if (tv > _hwm) {
    if (!_hwmCrossedAt) _hwmCrossedAt = Date.now();

    const thresholdPct   = _phic.bank_profit_threshold_pct ?? 0.002;
    const tier1Frac      = Math.max(0.1, Math.min(1.0, _phic.bank_tier1_frac ?? 0.60));
    const fallbackMs     = (_phic.bank_profit_dwell_min ?? 10) * 60_000;
    const excess         = tv - _hwm;
    const excessPct      = excess / _hwm;
    const dwellElapsed   = Date.now() - _hwmCrossedAt;
    const minResidualBtc = 0.0002;  // leave at least this much BTC after extract

    // ── Tier 1: immediate partial bank when threshold is first crossed ────
    if (!_tier1Banked && excessPct >= thresholdPct) {
      const amount  = +(excess * tier1Frac).toFixed(2);
      const bankQty = +(amount / _livePrice).toFixed(6);
      if (bankQty >= 0.0001 && (_portfolio.btc || 0) >= bankQty + minResidualBtc) {
        _hwm         += amount;   // advance HWM — tier-2 targets the remainder
        _tier1Banked  = true;
        self.postMessage({ type: "profit_bank_initiated", tier: 1,
                           amount_usd: amount, qty_btc: bankQty, timestamp: Date.now() });
        const ok = await _submitOrder({
          pattern_id:  "BANK_EXTRACT",
          symbol:      _exchangeConfig?.symbol || "BTC/USDT",
          side:        "sell",
          quantity:    bankQty,
          limit_price: 0,
          regime_tag:  "LowVol",
          created_at:  Date.now(),
        });
        if (ok) {
          // _livePrice is updated to fill price by _submitOrder
          const proceeds = +(bankQty * (_livePrice || 1)).toFixed(2);
          _lockedUsdt   += proceeds;
          _bankedProfit += proceeds;
          self.postMessage({ type: "profit_banked", tier: 1,
                             amount_banked: proceeds, total_banked: +_bankedProfit.toFixed(2),
                             locked_usdt: +_lockedUsdt.toFixed(2), new_hwm: +_hwm.toFixed(2),
                             trigger: "fill_confirmed", timestamp: Date.now() });
          _emitPortfolio();
        }
      }
    }

    // ── Tier 2: remainder on velocity reversal OR fallback dwell ──────────
    if (_tier1Banked && (velReversal || dwellElapsed >= fallbackMs)) {
      const remaining = tv - _hwm;   // excess above the already-advanced HWM
      if (remaining > 0) {
        const bankQty = +(remaining / _livePrice).toFixed(6);
        if (bankQty >= 0.0001 && (_portfolio.btc || 0) >= bankQty + minResidualBtc) {
          _hwm = tv;
          self.postMessage({ type: "profit_bank_initiated", tier: 2,
                             amount_usd: remaining, qty_btc: bankQty, timestamp: Date.now() });
          const ok = await _submitOrder({
            pattern_id:  "BANK_EXTRACT",
            symbol:      _exchangeConfig?.symbol || "BTC/USDT",
            side:        "sell",
            quantity:    bankQty,
            limit_price: 0,
            regime_tag:  "LowVol",
            created_at:  Date.now(),
          });
          if (ok) {
            const proceeds = +(bankQty * (_livePrice || 1)).toFixed(2);
            _lockedUsdt   += proceeds;
            _bankedProfit += proceeds;
            self.postMessage({ type: "profit_banked", tier: 2,
                               amount_banked: proceeds, total_banked: +_bankedProfit.toFixed(2),
                               locked_usdt: +_lockedUsdt.toFixed(2), new_hwm: +_hwm.toFixed(2),
                               trigger: velReversal ? "velocity_reversal" : "dwell_fallback",
                               timestamp: Date.now() });
            _emitPortfolio();
          }
        } else {
          // Position too small to extract cleanly — sync HWM but don't bank
          _hwm = Math.max(_hwm, tv);
        }
      } else {
        // Price retraced between tier-1 and tier-2 — tier-1 fill already locked it. Sync HWM.
        _hwm = Math.max(_hwm, tv);
      }
      _hwmCrossedAt = null;
      _tier1Banked  = false;
    }

  } else {
    // tv at or below current HWM
    if (_tier1Banked) {
      // Tier-1 fill already landed — drop below new HWM means tier-2 window is gone.
      _hwmCrossedAt = null;
      _tier1Banked  = false;
    } else if (tv < _hwm * (1 - BANK_DWELL_RESET_BAND)) {
      // Pre-tier-1: only reset dwell on a meaningful drop (not CAP_TRIM fee noise).
      _hwmCrossedAt = null;
    }
  }
}

// ── Floor enforcement ─────────────────────────────────────────────────────
// The floor = _hwm × (1 − max_total_exposure_pct).  This is the hard stop —
// the most we are willing to lose from the running peak.
//
// Two-level response:
//   Warning zone (within FLOOR_WARN_BUFFER above floor): emit floor_warning →
//     echoforge_worker goes passive, no new intents generated.
//   Hard breach (tv ≤ floor): emit floor_breach → main thread triggers emergency
//     freeze across all workers.  Also cancel any open BTC via CASHOUT.
const FLOOR_WARN_BUFFER = 0.03;   // warn when within 3% above floor

let _floorWarnActive = false;     // prevents warning from firing every cycle
let _floorBreachFired = false;    // prevents freeze from firing every cycle

function _checkFloor() {
  const btcMtm = (_portfolio.btc || 0) * (_livePrice || 0);
  const tv = (_livePrice > 0 && _portfolio.btc >= 0)
    ? (_portfolio.usdt || 0) + btcMtm
    : (_portfolio.total_value || 0);
  if (tv <= 0 || _hwm <= 0) return;

  const floor    = _initialFloor + _lockedUsdt;  // rises permanently as real USDT is extracted
  const warnLine = floor * (1 + FLOOR_WARN_BUFFER);
  const now      = Date.now();

  if (tv <= floor) {
    if (!_floorBreachFired) {
      _floorBreachFired = true;
      self.postMessage({
        type:        "floor_breach",
        total_value: +tv.toFixed(2),
        floor:       +floor.toFixed(2),
        hwm:         +_hwm.toFixed(2),
        timestamp:   now,
      });
      // Forensic killswitch snapshot — captures full position state at moment of breach
      self.postMessage({
        type:        "killswitch_snapshot",
        trigger:     "floor_breach",
        portfolio:   { ..._portfolio },
        exposures:   Object.fromEntries(_exposureByPattern),
        hwm:         +_hwm.toFixed(2),
        banked:      +_bankedProfit.toFixed(2),
        velocity:    +_velocityEWMA.toFixed(6),
        floor:       +floor.toFixed(2),
        timestamp:   now,
      });
      // Best-effort: flatten any open BTC position before the freeze lands
      if (_portfolio.btc > 0.0001 && _exchangeConfig?.api_url) {
        _submitOrder({
          pattern_id:  "FLOOR_BREACH",
          symbol:      _exchangeConfig.symbol || "BTC/USDT",
          side:        "sell",
          quantity:    +_portfolio.btc.toFixed(6),
          limit_price: 0,
          regime_tag:  "Crisis",
          created_at:  now,
        });
      }
    }
  } else if (tv <= warnLine) {
    if (!_floorWarnActive) {
      _floorWarnActive = true;
      self.postMessage({
        type:        "floor_warning",
        total_value: +tv.toFixed(2),
        floor:       +floor.toFixed(2),
        warn_line:   +warnLine.toFixed(2),
        hwm:         +_hwm.toFixed(2),
        pct_above:   +(((tv - floor) / floor) * 100).toFixed(1),
        timestamp:   now,
      });
    }
  } else {
    // Recovered above warn line — reset so warnings can fire again next approach
    _floorWarnActive  = false;
    _floorBreachFired = false;
  }
}

// Periodic SAF drain — catches entries that queued while _online stayed true (e.g. server errors)
setInterval(() => { if (_online && _db) _replaySAF(); }, 30_000);
// Stop-loss is now tick-driven (fires on every price_tick when a position is open).
// The setInterval fallback is removed to avoid confusion — _checkStopLoss() is called
// directly in the price_tick handler so it fires within 8ms of the price crossing the threshold.
// Periodic profit banking check — extract surplus when portfolio holds above HWM
setInterval(() => { _checkBankProfits(); }, 30_000);
// Periodic floor check — proactive warning + hard enforcement when floor is approached/breached
setInterval(() => { _checkFloor(); }, 30_000);

function _getAllPending() {
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(SAF_STORE, "readonly");
    const index = tx.objectStore(SAF_STORE).index("status");
    const req   = index.getAll("PENDING");
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

function _updateSAFEntry(entryId, updates) {
  return new Promise((resolve, reject) => {
    const tx    = _db.transaction(SAF_STORE, "readwrite");
    const store = tx.objectStore(SAF_STORE);
    const getReq = store.get(entryId);
    getReq.onsuccess = () => {
      const rec = { ...getReq.result, ...updates };
      const putReq = store.put(rec);
      putReq.onsuccess = resolve;
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

async function _updateSAFStatus() {
  const pending = await _getAllPending();
  self.postMessage({ type: "saf_status", pending_count: pending.length });
}
