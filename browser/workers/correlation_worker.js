/**
 * correlation_worker.js — Web Worker 6
 *
 * Cross-pair correlation intelligence + cross-exchange lead-lag detection.
 *
 * Cross-pair metrics (BTC/ETH/SOL):
 *   RVR            σ_base / σ_quote (EWMA std, 5s halflife) — >1.5 = base abnormally volatile
 *   momentum_div   ema_fast_base − ema_fast_quote (normalised) — leading indicator
 *   pearson        rolling 60-tick Pearson r — <0.5 = correlation breakdown → arb signal
 *   flow_sync      buy/sell ratio sync between pairs — true = directional flow aligned
 *
 * Cross-exchange lead-lag (VALR vs Binance):
 *   exchange_lag_ms  EWMA of (VALR_ts − BINANCE_ts) for price-matched trades
 *   lead_exchange    whichever consistently has lower timestamp
 *   arb_detected     emitted when |lag| > LAG_EMIT_THRESHOLD_MS (15ms)
 *
 * Messages IN:
 *   {type:"init"}
 *   {type:"tick", symbol, price, momentum, buy_volume, sell_volume, timestamp, exchange?}
 *
 * Messages OUT:
 *   {type:"cross_pair_signal", base, quote, rvr, momentum_div, pearson, flow_sync, regime_tag, timestamp}
 *   {type:"arb_detected",      exchange_lag_ms, lead_exchange, lag_exchange, timestamp}
 */

"use strict";

const WINDOW        = 60;    // ticks for rolling Pearson
const EWMA_α        = 0.20;  // EWMA variance decay (~5s halflife at ~25 ticks/s)
const MIN_TICKS     = 10;    // guard: wait for warm-up before emitting
const EMIT_PAIRS    = [["BTCUSDT", "ETHUSDT"], ["BTCUSDT", "SOLUSDT"]];

const _pairs = {};  // symbol → {price, momentum, buy_volume, sell_volume, ewma_mean, ewma_var, history[], n}

// PHIC config — updated via phic_update messages
let _phic = { rvr_threshold: 1.5, pearson_threshold: 0.5, correlation_enabled: true };

// ── Cross-exchange lead/lag tracking ─────────────────────────────────────────
// Buffer recent trades per exchange; match within LAG_MATCH_WINDOW_MS + price tolerance.
// lag_ms = VALR_ts − BINANCE_ts: positive → VALR lags Binance (Binance leads).
const LAG_MATCH_WINDOW_MS  = 500;    // ms — match window for cross-exchange trade pairing
const LAG_PRICE_TOL        = 0.001;  // 0.1% price tolerance for trade matching
const LAG_EMIT_THRESHOLD   = 15;     // ms — emit arb_detected when EWMA lag exceeds this
const LAG_EWMA_α           = 0.15;   // lag EWMA decay

const _exBuf  = { VALR: [], BINANCE: [] };  // {p: price, t: timestamp}[]
let _lagEWMA  = 0;
let _lagCount = 0;     // total matched pairs — guard against noise before first 5 matches
let _arbLastEmitAt = 0;
const ARB_EMIT_COOLDOWN_MS = 5_000;  // emit arb_detected at most once every 5s

function _ensure(symbol, firstPrice) {
  if (!_pairs[symbol]) {
    _pairs[symbol] = {
      price: 0, momentum: 0, buy_volume: 0, sell_volume: 0,
      // Seed ewma_mean to the first observed price so the initial delta isn't the full
      // price magnitude (which would wildly inflate ewma_var on startup).
      ewma_mean: firstPrice || 0, ewma_var: 0,
      history: [],   // [{price, timestamp}] — capped at WINDOW
      n: 0,
    };
  }
  return _pairs[symbol];
}

function _updateExchangeLag(exchange, price, timestamp) {
  const buf = _exBuf[exchange];
  if (!buf) return;

  // Evict stale entries
  const cutoff = timestamp - LAG_MATCH_WINDOW_MS;
  while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
  buf.push({ p: price, t: timestamp });

  // Find the best price match in the other exchange's buffer
  const other = exchange === "VALR" ? "BINANCE" : "VALR";
  const otherBuf = _exBuf[other];
  if (!otherBuf || otherBuf.length === 0) return;

  let best = null;
  let bestDiff = Infinity;
  for (const e of otherBuf) {
    const diff = Math.abs((e.p - price) / price);
    if (diff < LAG_PRICE_TOL && diff < bestDiff) { bestDiff = diff; best = e; }
  }
  if (!best) return;

  const valrTs = exchange === "VALR"    ? timestamp : best.t;
  const binTs  = exchange === "BINANCE" ? timestamp : best.t;
  const lagMs  = valrTs - binTs;

  _lagEWMA = _lagCount === 0 ? lagMs : _lagEWMA * (1 - LAG_EWMA_α) + lagMs * LAG_EWMA_α;
  _lagCount++;

  if (_lagCount >= 5 && Math.abs(_lagEWMA) > LAG_EMIT_THRESHOLD) {
    const now = Date.now();
    if (now - _arbLastEmitAt >= ARB_EMIT_COOLDOWN_MS) {
      _arbLastEmitAt = now;
      self.postMessage({
        type:             "arb_detected",
        exchange_lag_ms:  +_lagEWMA.toFixed(1),
        lead_exchange:    _lagEWMA > 0 ? "BINANCE" : "VALR",
        lag_exchange:     _lagEWMA > 0 ? "VALR"    : "BINANCE",
        timestamp:        now,
      });
    }
  }
}

function _update(msg) {
  const { symbol, price, momentum, buy_volume, sell_volume, timestamp, exchange } = msg;
  if (!symbol || !(price > 0)) return;

  // Cross-exchange lag: only track BTCUSDT to avoid cross-pair symbol confusion
  if (exchange && symbol === "BTCUSDT") {
    _updateExchangeLag(exchange, price, timestamp || Date.now());
  }

  const s = _ensure(symbol, price);
  s.price       = price;
  s.momentum    = momentum    ?? s.momentum;
  s.buy_volume  = buy_volume  ?? s.buy_volume;
  s.sell_volume = sell_volume ?? s.sell_volume;
  s.n++;

  // Online EWMA variance (Welford-style with exponential forgetting)
  const delta    = price - s.ewma_mean;
  s.ewma_mean   += EWMA_α * delta;
  s.ewma_var     = (1 - EWMA_α) * (s.ewma_var + EWMA_α * delta * delta);

  s.history.push({ price, timestamp: timestamp || Date.now() });
  if (s.history.length > WINDOW) s.history.shift();
}

function _pctStd(symbol) {
  const s = _pairs[symbol];
  if (!s || !(s.price > 0)) return 1;
  // Use percentage std (σ / price) so BTC at $76K and SOL at $140 are comparable.
  // Raw-dollar std produces RVR in the thousands because BTC's dollar moves dwarf SOL's.
  const dollarStd = Math.sqrt(Math.max(s.ewma_var, 1e-10));
  return dollarStd / s.price;
}

function _pearson(symA, symB) {
  const a = _pairs[symA];
  const b = _pairs[symB];
  if (!a || !b) return null;

  const n = Math.min(a.history.length, b.history.length, WINDOW);
  if (n < MIN_TICKS) return null;

  const pa = a.history.slice(-n).map(e => e.price);
  const pb = b.history.slice(-n).map(e => e.price);

  let meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanA += pa[i]; meanB += pb[i]; }
  meanA /= n; meanB /= n;

  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = pa[i] - meanA;
    const db = pb[i] - meanB;
    num += da * db;
    dA  += da * da;
    dB  += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom > 0 ? num / denom : 0;
}

function _emit(base, quote) {
  const a = _pairs[base];
  const b = _pairs[quote];
  if (!a || !b || a.n < MIN_TICKS || b.n < MIN_TICKS) return;

  const stdA = _pctStd(base);
  const stdB = _pctStd(quote);
  // Cap RVR at 10 — values above this indicate one symbol has no data yet (near-zero variance)
  // and the ratio is meaningless noise, not a genuine volatility divergence signal.
  const rvr  = Math.min(10, stdB > 0 ? stdA / stdB : 1);

  const pearson = _pearson(base, quote);
  if (pearson === null) return;

  const momDiv = a.momentum - b.momentum;

  const totalA  = a.buy_volume + a.sell_volume;
  const totalB  = b.buy_volume + b.sell_volume;
  const ratioA  = totalA > 0 ? a.buy_volume / totalA : 0.5;
  const ratioB  = totalB > 0 ? b.buy_volume / totalB : 0.5;
  const flowSync = Math.abs(ratioA - ratioB) < 0.15;

  // Derive a cross-pair regime tag using configurable thresholds
  const rvrT = _phic.rvr_threshold ?? 1.5;
  const regime_tag = Math.abs(pearson) < 0.35 ? "Crisis"
    : rvr > rvrT ? "HighVol"
    : "LowVol";

  self.postMessage({
    type:         "cross_pair_signal",
    base,
    quote,
    rvr:          +rvr.toFixed(4),
    momentum_div: +momDiv.toFixed(6),
    pearson:      +pearson.toFixed(4),
    flow_sync:    flowSync,
    regime_tag,
    timestamp:    Date.now(),
  });
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "init") {
    if (msg.phic) Object.assign(_phic, msg.phic);
    setInterval(() => {
      if (_phic.correlation_enabled === false) return;
      for (const [base, quote] of EMIT_PAIRS) _emit(base, quote);
    }, 1_000);
    return;
  }
  if (msg.type === "phic_update" && msg.config) {
    Object.assign(_phic, msg.config);
    return;
  }
  if (msg.type === "tick") {
    if (_phic.correlation_enabled === false) return;
    _update(msg);
  }
};
