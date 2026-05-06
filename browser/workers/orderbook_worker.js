/**
 * orderbook_worker.js — Web Worker 1
 *
 * Responsibilities:
 *   - Maintain live L2 orderbook (bids + asks sorted by price)
 *   - Compute bid-ask spread, top-of-book imbalance, mid-price
 *   - Write normalised ticks into the SharedArrayBuffer ring buffer
 *   - Detect depth anomalies (sudden thinning → alert main thread)
 *
 * Messages IN  (from main thread):
 *   {type:"init",   sab: SharedArrayBuffer}
 *   {type:"l2_snapshot", bids:[[price,qty],...], asks:[[price,qty],...], symbol, timestamp}
 *   {type:"l2_delta",    changes:[{side,price,qty},...], symbol, timestamp}
 *   {type:"trade",       price, quantity, side, timestamp, symbol}
 *
 * Messages OUT (to main thread):
 *   {type:"tick",        price, volume, side, timestamp, symbol, spread, imbalance}
 *   {type:"depth_alert", severity, detail}
 */

"use strict";

import { RingBufferWriter } from "../ring_buffer.js";

let _writer = null;

// Orderbook state: Map<price_str, qty>
const _bids = new Map();
const _asks = new Map();

// Rolling buy/sell volume for VPIN (forwarded to nociceptor)
// Decay calibrated to 200 ms synthetic tick rate; time-normalised in the trade handler.
let _buyVol  = 0;
let _sellVol = 0;
let _lastTradeMs = 0;
const VOLUME_DECAY_200MS = 0.95;

// ── OFI (Order Flow Imbalance) delta snapshot ──────────────────────────────
// Track previous top-5 bid/ask sizes for delta computation.
// Emits {type:"ofi_snapshot", features:[12]} throttled to 1 per 100ms.
const OFI_LEVELS           = 5;
const OFI_THROTTLE_MS      = 100;
const _prevBidSizes        = new Array(OFI_LEVELS).fill(0);
const _prevAskSizes        = new Array(OFI_LEVELS).fill(0);
let   _ofiLastEmitMs       = 0;
let   _ofiPendingFeatures  = null;   // buffered until throttle window elapses

// ── L2 depth snapshot ─────────────────────────────────────────────────────
// Emits top-10 bid/ask levels for the TradingDeck L2 panel, throttled 250ms.
const DEPTH_LEVELS         = 10;
const DEPTH_THROTTLE_MS    = 250;
let   _depthLastEmitMs     = 0;

// ── Whale Wake fingerprinting ─────────────────────────────────────────────────
// twap_score: EWMA of normalised trade-size regularity (near 0 = highly regular = TWAP bot)
// vwap_anchor: strength of price reversion toward VWAP after each imbalance push
const TWAP_WINDOW        = 20;   // tick window for autocorrelation
const TWAP_ALPHA         = 2 / (TWAP_WINDOW + 1);
let _twapScore           = 0.5;  // starts neutral; decays toward regularity when detected
let _lastTradeSize       = 0;
let _meanTradeSize       = 0;
let _vwapDevPrev         = 0;    // VWAP deviation at last tick (for anchor calc)

// ── Price analytics (EMA, z-score, momentum, VWAP) ─────────────────────────
// EMA half-lives are time-based so semantics stay consistent at any tick rate.
// Fast EMA ≈ 5 s half-life, Slow EMA ≈ 20 s half-life.
const EMA_FAST_HALFLIFE_MS  = 5_000;
const EMA_SLOW_HALFLIFE_MS  = 20_000;
const Z_SCORE_WINDOW_MS     = 30_000;  // 30-second rolling z-score window
const VWAP_HALFLIFE_MS      = 300_000; // 5-minute VWAP half-life

// PRICE_BUF entries: {p, t} — time-stamped so stale entries can be pruned
const PRICE_BUF = [];

let _emaFast  = 0;
let _emaSlow  = 0;
let _vwapNum  = 0;           // Σ(price × vol) with decay
let _vwapDen  = 0;           // Σ(vol) with decay
let _lastTickMs = 0;

function _updateAnalytics(px, vol, timestampMs) {
  if (px <= 0) return;
  const now = timestampMs || Date.now();
  const dt  = _lastTickMs > 0 ? Math.min(now - _lastTickMs, 5000) : 200;
  _lastTickMs = now;

  // Time-normalised EMA: α = 1 − exp(−dt · ln2 / halflife)
  if (_emaFast === 0) { _emaFast = px; _emaSlow = px; }
  const αFast = 1 - Math.exp(-dt * Math.LN2 / EMA_FAST_HALFLIFE_MS);
  const αSlow = 1 - Math.exp(-dt * Math.LN2 / EMA_SLOW_HALFLIFE_MS);
  _emaFast += αFast * (px - _emaFast);
  _emaSlow += αSlow * (px - _emaSlow);

  // Time-bounded z-score window: keep last Z_SCORE_WINDOW_MS of data
  PRICE_BUF.push({ p: px, t: now });
  while (PRICE_BUF.length > 0 && now - PRICE_BUF[0].t > Z_SCORE_WINDOW_MS) PRICE_BUF.shift();

  // Time-normalised VWAP decay
  const v     = vol || 0.001;
  const decay = Math.exp(-dt * Math.LN2 / VWAP_HALFLIFE_MS);
  _vwapNum = _vwapNum * decay + px * v;
  _vwapDen = _vwapDen * decay + v;
}

function _analytics(px) {
  const n    = PRICE_BUF.length;
  const vwap = _vwapDen > 0 ? _vwapNum / _vwapDen : px;
  if (n < 5) return { ema_fast: px || _emaFast, ema_slow: px || _emaSlow, z_score: 0, momentum: 0, vwap };

  const prices   = PRICE_BUF.map(e => e.p);
  const mean     = prices.reduce((s, x) => s + x, 0) / n;
  const variance = prices.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std      = Math.sqrt(variance) || 1;

  return {
    ema_fast: +_emaFast.toFixed(2),
    ema_slow: +_emaSlow.toFixed(2),
    z_score:  +((px - mean) / std).toFixed(3),
    momentum: _emaSlow > 0 ? +((_emaFast - _emaSlow) / _emaSlow).toFixed(6) : 0,
    vwap:     +vwap.toFixed(2),
  };
}

self.onmessage = (ev) => {
  const msg = ev.data;

  switch (msg.type) {
    case "init":
      _writer = new RingBufferWriter(msg.sab);
      break;

    case "l2_snapshot":
      // Only maintain a BTC/USDT order book — ignore other symbols to prevent price contamination
      // Normalise "BTC/USDT" and "BTCUSDT" to the same check
      if (msg.symbol && msg.symbol.replace("/", "") !== "BTCUSDT") break;
      _bids.clear();
      _asks.clear();
      for (const [p, q] of (msg.bids || [])) _bids.set(String(p), q);
      for (const [p, q] of (msg.asks || [])) _asks.set(String(p), q);
      _emitTick(msg.symbol, null, 0, null, msg.timestamp);
      break;

    case "l2_delta":
      if (msg.symbol && msg.symbol.replace("/", "") !== "BTCUSDT") break;
      for (const { side, price, qty } of (msg.changes || [])) {
        const m = side === "buy" ? _bids : _asks;
        if (qty === 0) {
          m.delete(String(price));
        } else {
          m.set(String(price), qty);
        }
      }
      _emitTick(msg.symbol, null, 0, null, msg.timestamp);
      break;

    case "trade": {
      // Non-BTC trades: emit tick for downstream consumption (e.g. correlation worker)
      // but do NOT update BTC analytics, order book, or ring buffer
      if (msg.symbol && msg.symbol.replace("/", "") !== "BTCUSDT") {
        _emitTick(msg.symbol, msg.side, msg.quantity, msg.price, msg.timestamp);
        break;
      }
      const tradeNow = msg.timestamp || Date.now();
      const tradeDt  = _lastTradeMs > 0 ? Math.min(tradeNow - _lastTradeMs, 2000) : 200;
      _lastTradeMs   = tradeNow;
      const volDecay = Math.pow(VOLUME_DECAY_200MS, tradeDt / 200);
      _buyVol  = _buyVol  * volDecay + (msg.side === "buy"  ? msg.quantity : 0);
      _sellVol = _sellVol * volDecay + (msg.side === "sell" ? msg.quantity : 0);
      _updateAnalytics(msg.price, msg.quantity, tradeNow);
      if (_writer) {
        const ts = Math.floor((msg.timestamp || Date.now()) / 1000);
        _writer.write(msg.price || 0, msg.quantity, msg.side === "buy", ts);
      }
      _emitTick(msg.symbol, msg.side, msg.quantity, msg.price, msg.timestamp);
      break;
    }
  }
};

function _emitDepthUpdate() {
  const now = Date.now();
  if (now - _depthLastEmitMs < DEPTH_THROTTLE_MS) return;
  _depthLastEmitMs = now;

  const bids = [..._bids.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, DEPTH_LEVELS)
    .map(([p, q]) => [Number(p), q]);
  const asks = [..._asks.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(0, DEPTH_LEVELS)
    .map(([p, q]) => [Number(p), q]);

  self.postMessage({ type: "depth_update", depth: { bids, asks }, timestamp: now });
}

function _computeAndQueueOfi(mid, spread) {
  // Sort bids descending, asks ascending — take top OFI_LEVELS entries
  const sortedBids = [..._bids.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, OFI_LEVELS);
  const sortedAsks = [..._asks.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(0, OFI_LEVELS);

  const deltaBids = new Array(OFI_LEVELS).fill(0);
  const deltaAsks = new Array(OFI_LEVELS).fill(0);
  for (let i = 0; i < OFI_LEVELS; i++) {
    const curBid  = sortedBids[i] ? Number(sortedBids[i][1]) : 0;
    const curAsk  = sortedAsks[i] ? Number(sortedAsks[i][1]) : 0;
    deltaBids[i]  = curBid - _prevBidSizes[i];
    deltaAsks[i]  = curAsk - _prevAskSizes[i];
    _prevBidSizes[i] = curBid;
    _prevAskSizes[i] = curAsk;
  }

  const total     = _buyVol + _sellVol;
  const vpin      = total > 0 ? Math.abs(_buyVol - _sellVol) / total : 0;
  const spreadNrm = mid > 0 ? Math.min(spread / mid, 0.01) / 0.01 : 0;

  _ofiPendingFeatures = [...deltaBids, ...deltaAsks, +vpin.toFixed(4), +spreadNrm.toFixed(4)];

  const now = Date.now();
  if (now - _ofiLastEmitMs >= OFI_THROTTLE_MS) {
    _ofiLastEmitMs = now;
    self.postMessage({ type: "ofi_snapshot", features: _ofiPendingFeatures, timestamp: now });
    _ofiPendingFeatures = null;
  }
}

function _emitTick(symbol, side, tradeQty, tradePrice, timestamp) {
  // No orderbook yet — emit a minimal tick so downstream latency/VPIN still runs
  if (_bids.size === 0 && _asks.size === 0) {
    const a = _analytics(tradePrice || 0);
    self.postMessage({
      type: "tick", symbol, price: tradePrice || 0, volume: tradeQty,
      side, timestamp, spread: 0, imbalance: 0,
      buy_volume: _buyVol, sell_volume: _sellVol,
      ...a,
    });
    return;
  }

  const bestBid = Math.max(...[..._bids.keys()].map(Number));
  const bestAsk = Math.min(...[..._asks.keys()].map(Number));
  const mid     = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
  const spread  = bestAsk - bestBid;

  // OFI snapshot + depth update — both throttled; only when we have real book depth
  _computeAndQueueOfi(mid, spread);
  _emitDepthUpdate();

  const bidQty    = _bids.get(String(bestBid)) || 0;
  const askQty    = _asks.get(String(bestAsk)) || 0;
  const total     = bidQty + askQty;
  const imbalance = total > 0 ? (bidQty - askQty) / total : 0;

  if (total > 0 && total < 0.01) {
    self.postMessage({
      type: "depth_alert", severity: 0.7,
      detail: `Thin book: bid=${bidQty.toFixed(4)} ask=${askQty.toFixed(4)}`,
    });
  }

  // L2 deltas also write to ring buffer if a trade side is known
  if (side && _writer) {
    const ts = Math.floor((timestamp || Date.now()) / 1000);
    _writer.write(mid, tradeQty, side === "buy", ts);
  }

  const a = _analytics(tradePrice || mid || 0);

  // ── Whale Wake fingerprinting ───────────────────────────────────────────────
  // TWAP score: EWMA of |size_i - size_{i-1}| / mean_size (near 0 = highly regular)
  if (tradeQty > 0 && _lastTradeSize > 0) {
    _meanTradeSize = _meanTradeSize === 0 ? tradeQty
      : _meanTradeSize * (1 - TWAP_ALPHA) + tradeQty * TWAP_ALPHA;
    const sizeVariation = _meanTradeSize > 0
      ? Math.abs(tradeQty - _lastTradeSize) / _meanTradeSize : 1;
    _twapScore = _twapScore * (1 - TWAP_ALPHA) + sizeVariation * TWAP_ALPHA;
  }
  if (tradeQty > 0) _lastTradeSize = tradeQty;

  // VWAP anchor: how strongly price reverted toward VWAP relative to imbalance magnitude
  const vwapDev    = a.vwap > 0 ? (mid - a.vwap) / a.vwap : 0;
  const vwapRevert = _vwapDevPrev !== 0 && Math.abs(imbalance) > 0.05
    ? Math.max(0, 1 - Math.abs(vwapDev) / (Math.abs(_vwapDevPrev) + 1e-9)) : 0;
  _vwapDevPrev     = vwapDev;

  self.postMessage({
    type: "tick", symbol, price: mid, volume: tradeQty,
    side, timestamp, spread, imbalance,
    buy_volume: _buyVol, sell_volume: _sellVol,
    twap_score:  +_twapScore.toFixed(3),   // near 0 = institutional TWAP detected
    vwap_anchor: +vwapRevert.toFixed(3),   // near 1 = VWAP-anchored algo active
    ...a,
  });
}
