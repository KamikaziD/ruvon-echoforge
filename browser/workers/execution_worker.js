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
let _rateLimitUntil  = 0;
let _replaying       = false;   // prevents re-enqueue during SAF replay
const SAF_MAX_RETRIES = 5;      // expire SAF entry after this many failed replays

let _isSovereign = true;

// Live price — 0 until first real tick; execution is gated until seeded
let _livePrice = 0;

// Per-pattern cooldown — prevent over-trading the same pattern
const _patternLastTrade  = new Map();  // pattern_id → timestamp ms
const PATTERN_COOLDOWN_MS = 30_000;   // 30s minimum between same-pattern trades

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
let _bankedProfit    = 0.0;       // cumulative profits locked in safe reserve
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

// Per-pair trade stats (accumulated across fills)
const _tradesByPair = {};  // symbol → { count, wins, realized_pnl }

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
  self.postMessage({
    type:          "portfolio_update",
    ..._portfolio,
    hwm:           +_hwm.toFixed(2),
    banked_profit: +_bankedProfit.toFixed(2),
    positions:     _buildPositions(),
    timestamp:     Date.now(),
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
      await _openSAF();
      await _syncFromExchange();   // seed portfolio + live price from VALR
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
    case "price_tick":
      if (msg.price > 0) _livePrice = msg.price;
      break;
    case "network_status":
      _online = msg.online;
      if (_online) await _replaySAF();
      break;
    case "cashout":
      await _handleCashout();
      break;
  }
};

async function _handleIntent(intent) {
  if (_phic.emergency_freeze) return;
  if (Date.now() < _rateLimitUntil) return;

  const { pattern_id, net_aliveness, regime_tag, direction } = intent;

  // Sync live price from main thread's real market price (Binance stream or synthetic)
  if (intent.market_price > 0) _livePrice = intent.market_price;

  // Gate all execution until a real price has arrived — never trade on a stale seed
  if (_livePrice === 0) return;

  // Per-pattern cooldown: don't hammer the same pattern faster than 30s
  const lastTrade = _patternLastTrade.get(pattern_id) || 0;
  if (Date.now() - lastTrade < PATTERN_COOLDOWN_MS) return;

  const side = direction || "buy";

  // Available balance = total minus what's already committed to in-flight orders
  const availUsdt = Math.max(0, _portfolio.usdt - _reservedUsdt);
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
      const totalExpPct = (_portfolio.btc * (_livePrice || 1)) / totalVal;
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
  const conviction = Math.pow(Math.max(0.1, Math.min(1.0, net_aliveness ?? 0.5)), 1.5);

  // Kelly fraction: f* = (p_up - 0.5) / (1 - p_up) for a binary outcome
  // Clamp tightly — full Kelly is mathematically optimal but practically too aggressive
  const pUp        = Math.max(0.50, Math.min(0.95, intent.p_up || 0.55));
  const kellyRaw   = (pUp - 0.5) / Math.max(0.01, 1 - pUp);
  const kelly      = Math.max(0.05, Math.min(0.40, kellyRaw));  // cap at 40% Kelly

  // Size from available (not total) balance so concurrent orders don't over-commit.
  // For strong sell signals when the position is underwater: floor conviction × kelly so that
  // even near-dead patterns sell a meaningful fraction rather than the 0.0001 BTC minimum.
  const isStrongBearSell = side === "sell"
    && (intent.net_alpha ?? 0) < -0.005
    && (intent.unrealized_pnl_norm ?? 0) < -0.003;
  const sellFloor = isStrongBearSell ? Math.max(conviction * kelly, 0.15) : conviction * kelly;

  let qty = side === "buy"
    ? (availUsdt * auto * posPct * conviction * kelly) / _livePrice
    : (availBtc  * auto * posPct * sellFloor);

  // Arb positions must be small — the timing window is tight; cap at 0.1 BTC
  if (pattern_id === "ARBI_CROSS_EXCHANGE") qty = Math.min(qty, 0.1);

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
      _rateLimitUntil = Date.now() + retryAfter * 1000;
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

    // Record trade time for per-pattern cooldown
    _patternLastTrade.set(order.pattern_id, Date.now());

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
    } else if (order.pattern_id === "CAP_TRIM" || order.pattern_id === "STOP_LOSS") {
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
      _reservedBtc = 0;
    }

    // Outcome score: sign of realized PnL for sells; small positive for buys
    const pnlRaw = result.pnl_realized ?? 0;
    const refSize = (result.filled_price || _livePrice) * (result.filled_qty ?? 0.001) * 0.01;
    const outcomeScore = result.side === "sell"
      ? Math.max(-1, Math.min(1, pnlRaw / Math.max(refSize, 0.001)))
      : 0.15;

    _recordTrade(order.symbol || "BTC/USDT", pnlRaw);
    _execSuccesses++;
    _emitStats();
    self.postMessage({ type: "execution_result", pattern_id: order.pattern_id, outcome_score: outcomeScore, regime_tag: order.regime_tag });
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

// ── Cap overage trim ──────────────────────────────────────────────────────
// Called when a buy is rejected by the total exposure cap.
// Sells just enough BTC to bring the position back to the cap target.
// Throttled to once per minute to avoid sell churn.
let _capTrimLastAt = 0;
const CAP_TRIM_COOLDOWN_MS = 15_000;  // 15s — aggressive enough that re-accumulation is caught quickly
const CAP_TRIM_TARGET      = 0.70;    // trim to 70% of cap, leaving room for ~1 buy before cap fires again

async function _maybeCapTrim(maxTotalPct, totalVal) {
  const now = Date.now();
  if (now - _capTrimLastAt < CAP_TRIM_COOLDOWN_MS) return;
  if (!_exchangeConfig?.api_url || _livePrice === 0 || _portfolio.btc < 0.0001) return;

  const totalExpPct = (_portfolio.btc * _livePrice) / totalVal;
  if (totalExpPct <= maxTotalPct + 0.002) return;  // only trim if >0.2% over cap

  _capTrimLastAt = now;
  const targetBtc = (maxTotalPct * CAP_TRIM_TARGET * totalVal) / _livePrice;
  const trimBtc   = Math.max(0.0001, +(_portfolio.btc - targetBtc).toFixed(6));

  await _submitOrder({
    pattern_id:  "CAP_TRIM",
    symbol:      _exchangeConfig.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    +Math.min(trimBtc, _portfolio.btc).toFixed(6),
    limit_price: 0,
    regime_tag:  "LowVol",
    created_at:  now,
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

  const now = Date.now();
  if (now - _stopLossLastAt < STOP_LOSS_COOLDOWN_MS) return;
  _stopLossLastAt = now;

  const sellQty = +Math.max(0.0001, (_portfolio.btc * STOP_LOSS_SELL_FRAC).toFixed(6));
  await _submitOrder({
    pattern_id:  "STOP_LOSS",
    symbol:      _exchangeConfig.symbol || "BTC/USDT",
    side:        "sell",
    quantity:    Math.min(sellQty, _portfolio.btc),
    limit_price: 0,
    regime_tag:  "LowVol",
    created_at:  now,
  });
}

// ── Profit banking (two-tier velocity-aware) ─────────────────────────────
function _checkBankProfits() {
  const tv = _portfolio.total_value || 0;
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

    const thresholdPct = _phic.bank_profit_threshold_pct ?? 0.002;  // 0.2% default
    const tier1Frac    = Math.max(0.1, Math.min(1.0, _phic.bank_tier1_frac ?? 0.60));
    const fallbackMs   = (_phic.bank_profit_dwell_min ?? 10) * 60_000;
    const excess       = tv - _hwm;
    const excessPct    = excess / _hwm;
    const dwellElapsed = Date.now() - _hwmCrossedAt;

    // ── Tier 1: immediate partial bank when threshold is first crossed ────
    // No dwell required — locks in the bulk of the gain before any reversal.
    // HWM advances by the tier-1 amount; tier-2 measures the remaining excess.
    if (!_tier1Banked && excessPct >= thresholdPct) {
      const amount  = +(excess * tier1Frac).toFixed(2);
      _bankedProfit += amount;
      _hwm          += amount;   // advance HWM → tier-2 targets the remainder
      _tier1Banked   = true;
      self.postMessage({
        type:          "profit_banked",
        tier:          1,
        amount_banked: amount,
        total_banked:  +_bankedProfit.toFixed(2),
        new_hwm:       +_hwm.toFixed(2),
        trigger:       "threshold_crossed",
        timestamp:     Date.now(),
      });
      _emitPortfolio();
    }

    // ── Tier 2: remainder on velocity reversal OR fallback dwell ──────────
    if (_tier1Banked && (velReversal || dwellElapsed >= fallbackMs)) {
      const remaining = tv - _hwm;   // excess above the already-advanced HWM
      if (remaining > 0) {
        _bankedProfit += remaining;
        _hwm           = tv;
        self.postMessage({
          type:          "profit_banked",
          tier:          2,
          amount_banked: +remaining.toFixed(2),
          total_banked:  +_bankedProfit.toFixed(2),
          new_hwm:       +_hwm.toFixed(2),
          trigger:       velReversal ? "velocity_reversal" : "dwell_fallback",
          timestamp:     Date.now(),
        });
        _emitPortfolio();
      } else {
        // Price retraced between tier-1 and tier-2 — nothing left to bank,
        // but tier-1 profit is already locked. Just sync HWM.
        _hwm = Math.max(_hwm, tv);
      }
      _hwmCrossedAt = null;
      _tier1Banked  = false;
    }

  } else {
    // tv at or below current HWM
    if (_tier1Banked) {
      // After tier-1 already advanced _hwm: any drop back at/below the new HWM means
      // the momentum has reversed. Tier-2 opportunity is gone; reset state cleanly.
      // (Tier-1 profit is already banked — nothing is lost.)
      // Skip the hysteresis band here — it only guards the pre-tier-1 dwell clock.
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
  const tv = _portfolio.total_value || 0;
  if (tv <= 0 || _hwm <= 0) return;

  const expPct   = _phic.max_total_exposure_pct ?? 0.20;
  const floor    = _hwm * (1 - expPct);
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
// Periodic stop-loss check — independent of signal flow, watches the whole book
setInterval(() => { _checkStopLoss(); }, 30_000);
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
