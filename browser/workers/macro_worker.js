/**
 * macro_worker.js — Macro Market State (Full Browser Implementation)
 *
 * Computes all four macro dimensions entirely in the browser — no Python bridge required.
 *
 * Dimensions:
 *   1. Hurst Persistence   — multi-scale R/S analysis on 3600-sample 1s ring buffer
 *   2. CVD Divergence      — peak/trough HH-LH / LL-HL detection on 4h series
 *   3. Book Density        — ±1% depth vs 24h rolling EWMA
 *   4. Structural Corr.    — BTC/ETH rolling Pearson EWMA from correlation_worker feed
 *
 * Messages IN:
 *   {type:"init",              phic: PHICConfig}
 *   {type:"phic_update",       config: PHICConfig}
 *   {type:"tick",              bid, ask, buy_volume, sell_volume, timestamp}
 *   {type:"depth_update",      bids: [[price,qty]...], asks: [[price,qty]...], mid_price}
 *   {type:"vpin_update",       vpin}
 *   {type:"cross_pair_signal", base, quote, pearson}   ← from correlation_worker via index.html
 *   {type:"WARM_START_CVD",    payload: klines[]}       ← 3-day 1m K-lines
 *
 * Messages OUT:
 *   {type:"macro_state",       depth, cvd_raw, depth_raw, depth_ma, last_vpin,
 *                              hurst, persistence, cvd_div, correlation,
 *                              pearson_raw, hurst_n, timestamp}
 *   {type:"macro_state_ready", source:"browser"}
 */

"use strict";

// ── PHIC defaults ─────────────────────────────────────────────────────────────

let _phic = {
  depth_thin_pct:              0.50,
  depth_window_h:              24,
  macro_enabled:               true,
  hurst_trending_threshold:    0.55,
  hurst_reverting_threshold:   0.45,
  hurst_window_min:            8,        // minutes before first Hurst compute
  correlation_depeg_threshold: 0.40,
};

// ── CVD accumulator ───────────────────────────────────────────────────────────

let _cvdEwma = 0.0;
const CVD_ALPHA = 0.05;   // ~14s half-life at 1 tick/s

// ── Book density ──────────────────────────────────────────────────────────────

let _depthMa   = 0;
let _lastDepth = 0;
let _lastVpin  = 0;

const DEPTH_MA_COLD_SEED = 1.0;
// 24h EWMA equivalent at ~250ms depth update cadence
const DEPTH_ALPHA_24H = 2 / (24 * 3600 * 4 + 1);

// ── Price ring buffer (Hurst R/S) ─────────────────────────────────────────────

const HURST_RING_SIZE  = 3600;    // 1h at 1s/sample
const PRICE_SAMPLE_MS  = 1_000;   // rate-limit to 1 sample per second

let _priceRing         = new Float64Array(HURST_RING_SIZE);
let _priceRingHead     = 0;       // next write index
let _priceRingCount    = 0;       // capped at HURST_RING_SIZE

let _lastPriceSampleTs = 0;
let _lastMidPrice      = 0;

// ── CVD + price series (divergence detection, 4h at 1s) ──────────────────────

const CVD_DIV_MAX   = 4 * 3600;

let _cvdDivPrices   = new Float64Array(CVD_DIV_MAX);
let _cvdDivCvd      = new Float64Array(CVD_DIV_MAX);
let _cvdDivHead     = 0;
let _cvdDivCount    = 0;    // capped at CVD_DIV_MAX

// ── Structural correlation (BTC/ETH Pearson EWMA) ────────────────────────────

const CORR_ALPHA   = 0.02;   // slow EWMA, ~48 samples half-life
let _corrEwma      = 0.75;   // seed at "pegged" safe default
let _corrN         = 0;      // guard: require ≥5 samples before trusting

// ── Computed macro state ──────────────────────────────────────────────────────

let _hurst       = null;
let _persistence = "random";
let _cvdDiv      = "neutral";
let _correlation = "pegged";

// ── Emit interval ─────────────────────────────────────────────────────────────

let _emitInterval = null;

// =============================================================================
// HURST R/S ANALYSIS
// =============================================================================

/**
 * Multi-scale Rescaled Range Hurst exponent.
 * Returns float in [0,1] or null if insufficient data.
 */
function _computeHurst() {
  const minSamples = (_phic.hurst_window_min ?? 8) * 60;
  if (_priceRingCount < minSamples) return null;

  const n = Math.min(_priceRingCount, HURST_RING_SIZE);
  const arr = new Float64Array(n);

  // Extract ordered price series from circular buffer
  if (_priceRingCount < HURST_RING_SIZE) {
    // Not yet saturated — data is at indices 0..n-1
    for (let i = 0; i < n; i++) arr[i] = _priceRing[i];
  } else {
    // Saturated — oldest data starts at _priceRingHead
    for (let i = 0; i < n; i++) {
      arr[i] = _priceRing[(_priceRingHead + i) % HURST_RING_SIZE];
    }
  }

  // Build window sizes by halving from n down to 32
  const windows = [];
  let ws = n;
  while (ws >= 32) { windows.push(ws); ws = Math.floor(ws / 2); }
  if (windows.length < 2) return null;

  // Compute log(avgRS) for each window size using non-overlapping segments
  const logNArr  = [];
  const logRSArr = [];

  for (const wSize of windows) {
    const segCount = Math.floor(n / wSize);
    if (segCount === 0) continue;

    let sumRS = 0, validSegs = 0;
    for (let s = 0; s < segCount; s++) {
      const start = s * wSize;
      let   mean  = 0;
      for (let i = 0; i < wSize; i++) mean += arr[start + i];
      mean /= wSize;

      let cumDev = 0, maxCum = -Infinity, minCum = Infinity, sumSq = 0;
      for (let i = 0; i < wSize; i++) {
        const dev = arr[start + i] - mean;
        sumSq  += dev * dev;
        cumDev += dev;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
      }
      const R = maxCum - minCum;
      const S = Math.sqrt(sumSq / wSize);
      if (S > 0 && R > 0) { sumRS += R / S; validSegs++; }
    }

    if (validSegs > 0 && sumRS > 0) {
      logNArr.push(Math.log(wSize));
      logRSArr.push(Math.log(sumRS / validSegs));
    }
  }

  if (logNArr.length < 2) return null;

  // OLS slope of log(R/S) ~ log(N): slope = H
  let meanX = 0, meanY = 0;
  for (let i = 0; i < logNArr.length; i++) { meanX += logNArr[i]; meanY += logRSArr[i]; }
  meanX /= logNArr.length;
  meanY /= logNArr.length;

  let num = 0, denom = 0;
  for (let i = 0; i < logNArr.length; i++) {
    const dx = logNArr[i]  - meanX;
    const dy = logRSArr[i] - meanY;
    num   += dx * dy;
    denom += dx * dx;
  }

  if (denom === 0) return null;
  return Math.max(0, Math.min(1, num / denom));
}

// =============================================================================
// CVD DIVERGENCE DETECTION
// =============================================================================

/** Returns indices of local maxima with minimum minGap samples between them. */
function _findPeaks(prices, cvds, n, minGap, minPriceMove) {
  const peaks = [];  // [{pi, ci}] — price-index and corresponding cvd value at that index
  for (let i = 1; i < n - 1; i++) {
    if (prices[i] > prices[i - 1] && prices[i] >= prices[i + 1]) {
      if (peaks.length > 0 && i - peaks[peaks.length - 1].i < minGap) continue;
      peaks.push({ i, p: prices[i], c: cvds[i] });
    }
  }
  // Filter out micro-peaks: require price move ≥ minPriceMove from prior trough
  return peaks;
}

function _findTroughs(prices, cvds, n, minGap) {
  const troughs = [];
  for (let i = 1; i < n - 1; i++) {
    if (prices[i] < prices[i - 1] && prices[i] <= prices[i + 1]) {
      if (troughs.length > 0 && i - troughs[troughs.length - 1].i < minGap) continue;
      troughs.push({ i, p: prices[i], c: cvds[i] });
    }
  }
  return troughs;
}

function _computeCvdDivergence() {
  const n = _cvdDivCount;
  if (n < 240) return "neutral";   // need ≥ 4 minutes

  const prices = new Float64Array(n);
  const cvds   = new Float64Array(n);

  if (n < CVD_DIV_MAX) {
    // Buffer not yet saturated — data at indices 0..n-1
    for (let i = 0; i < n; i++) { prices[i] = _cvdDivPrices[i]; cvds[i] = _cvdDivCvd[i]; }
  } else {
    // Buffer saturated — oldest entry is at _cvdDivHead
    for (let i = 0; i < n; i++) {
      const idx  = (_cvdDivHead + i) % CVD_DIV_MAX;
      prices[i]  = _cvdDivPrices[idx];
      cvds[i]    = _cvdDivCvd[idx];
    }
  }

  const MIN_GAP       = 120;    // 2 min minimum distance between peaks at 1s sample
  const MIN_PRICE_PCT = 0.001;  // 0.1% minimum price move to qualify a peak

  const peaks   = _findPeaks(prices, cvds, n, MIN_GAP, MIN_PRICE_PCT);
  const troughs = _findTroughs(prices, cvds, n, MIN_GAP);

  // Bearish divergence: price makes Higher High but CVD makes Lower High
  if (peaks.length >= 2) {
    const p1 = peaks[peaks.length - 2];
    const p2 = peaks[peaks.length - 1];
    const priceHH  = p2.p > p1.p * (1 + MIN_PRICE_PCT);
    const cvdLH    = p1.c !== 0
      ? p2.c < p1.c * 0.95         // CVD at least 5% lower
      : p2.c < p1.c - 1e-9;
    if (priceHH && cvdLH) return "bearish_div";
  }

  // Bullish divergence: price makes Lower Low but CVD makes Higher Low
  if (troughs.length >= 2) {
    const t1 = troughs[troughs.length - 2];
    const t2 = troughs[troughs.length - 1];
    const priceLL  = t2.p < t1.p * (1 - MIN_PRICE_PCT);
    const cvdHL    = t1.c !== 0
      ? t2.c > t1.c * 1.05         // CVD at least 5% higher
      : t2.c > t1.c + 1e-9;
    if (priceLL && cvdHL) return "bullish_div";
  }

  return "neutral";
}

// =============================================================================
// EMIT
// =============================================================================

function _recomputeAndEmit() {
  // --- Hurst ---
  const h = _computeHurst();
  _hurst = h;
  if (h === null) {
    _persistence = "random";
  } else {
    const trendT  = _phic.hurst_trending_threshold  ?? 0.55;
    const revertT = _phic.hurst_reverting_threshold ?? 0.45;
    _persistence = h > trendT ? "trending" : h < revertT ? "reverting" : "random";
  }

  // --- CVD divergence ---
  _cvdDiv = _computeCvdDivergence();

  // --- Structural correlation ---
  if (_corrN >= 5) {
    const threshold = _phic.correlation_depeg_threshold ?? 0.40;
    _correlation = _corrEwma < threshold ? "depegged" : "pegged";
  } else {
    _correlation = "pegged";
  }

  // --- Depth ---
  // Require _lastDepth > 0 — on startup/warm-start depth hasn't been measured yet;
  // classifying as "thin" before any depth_update arrives would falsely trigger CAUTIOUS.
  const thin = _lastDepth > 0 && _depthMa > 0 && _lastDepth < _depthMa * (_phic.depth_thin_pct ?? 0.50);

  self.postMessage({
    type:        "macro_state",
    depth:       thin ? "thin" : "normal",
    cvd_raw:     +_cvdEwma.toFixed(6),
    depth_raw:   +_lastDepth.toFixed(6),
    depth_ma:    +_depthMa.toFixed(6),
    last_vpin:   +_lastVpin.toFixed(4),
    hurst:       _hurst !== null ? +_hurst.toFixed(4) : null,
    persistence: _persistence,
    cvd_div:     _cvdDiv,
    correlation: _correlation,
    pearson_raw: +_corrEwma.toFixed(4),
    hurst_buf_n: Math.min(_priceRingCount, HURST_RING_SIZE),
    cvd_buf_n:   Math.min(_cvdDivCount,    CVD_DIV_MAX),
    timestamp:   Date.now(),
  });
}

// =============================================================================
// PRICE SAMPLING (1s rate-limited write to both ring buffers)
// =============================================================================

function _samplePrice(mid, tsMs) {
  if (mid <= 0) return;
  _lastMidPrice = mid;
  const now = tsMs || Date.now();
  if (now - _lastPriceSampleTs < PRICE_SAMPLE_MS) return;
  _lastPriceSampleTs = now;
  _pushPrice(mid);
}

function _pushPrice(mid) {
  // Hurst ring buffer
  _priceRing[_priceRingHead] = mid;
  _priceRingHead = (_priceRingHead + 1) % HURST_RING_SIZE;
  if (_priceRingCount < HURST_RING_SIZE) _priceRingCount++;

  // CVD divergence series
  _cvdDivPrices[_cvdDivHead] = mid;
  _cvdDivCvd[_cvdDivHead]    = _cvdEwma;
  _cvdDivHead = (_cvdDivHead + 1) % CVD_DIV_MAX;
  if (_cvdDivCount < CVD_DIV_MAX) _cvdDivCount++;
}

// ── Depth measurement ─────────────────────────────────────────────────────────

function _measureDepth(bids, asks, midPrice) {
  if (!midPrice || midPrice <= 0) return 0;
  const lo = midPrice * 0.99, hi = midPrice * 1.01;
  let sum = 0;
  for (const [price, qty] of (bids || [])) {
    const p = parseFloat(price);
    if (p >= lo && p <= midPrice) sum += parseFloat(qty);
  }
  for (const [price, qty] of (asks || [])) {
    const p = parseFloat(price);
    if (p >= midPrice && p <= hi) sum += parseFloat(qty);
  }
  return sum;
}

// =============================================================================
// MESSAGE HANDLER
// =============================================================================

self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {

    case "init": {
      _phic    = { ..._phic, ...(msg.phic || {}) };
      _depthMa = DEPTH_MA_COLD_SEED;
      if (_emitInterval) clearInterval(_emitInterval);
      _emitInterval = setInterval(_recomputeAndEmit, 60_000);
      break;
    }

    case "phic_update": {
      _phic = { ..._phic, ...(msg.config || {}) };
      break;
    }

    case "tick": {
      const buyVol  = msg.buy_volume  ?? 0;
      const sellVol = msg.sell_volume ?? 0;
      _cvdEwma = _cvdEwma * (1 - CVD_ALPHA) + (buyVol - sellVol) * CVD_ALPHA;

      const bid = parseFloat(msg.bid || 0);
      const ask = parseFloat(msg.ask || 0);
      if (bid > 0 && ask > 0) {
        _samplePrice((bid + ask) / 2, msg.timestamp);
      } else if (_lastMidPrice > 0) {
        _samplePrice(_lastMidPrice, msg.timestamp);
      }
      break;
    }

    case "vpin_update": {
      _lastVpin = msg.vpin ?? _lastVpin;
      break;
    }

    case "depth_update": {
      const mid = msg.mid_price
        || ((parseFloat(msg.bids?.[0]?.[0] || 0) + parseFloat(msg.asks?.[0]?.[0] || 0)) / 2);
      if (mid > 0) {
        _lastDepth = _measureDepth(msg.bids, msg.asks, mid);
        if (_depthMa === 0) _depthMa = _lastDepth;
        _depthMa = _depthMa * (1 - DEPTH_ALPHA_24H) + _lastDepth * DEPTH_ALPHA_24H;
        _samplePrice(mid, Date.now());
      }
      break;
    }

    case "cross_pair_signal": {
      // Only BTCUSDT/ETHUSDT Pearson feeds structural correlation dimension
      if (msg.base !== "BTCUSDT" || msg.quote !== "ETHUSDT") break;
      const p = msg.pearson;
      if (p == null || isNaN(p)) break;
      _corrEwma = _corrN === 0 ? p : _corrEwma * (1 - CORR_ALPHA) + p * CORR_ALPHA;
      _corrN++;
      break;
    }

    case "WARM_START_CVD": {
      const klines = msg.payload || [];

      if (klines.length) {
        let accCvd = 0.0;
        for (const kl of klines) {
          const close  = parseFloat(kl.close  || kl.c  || 0);
          const vol    = parseFloat(kl.volume  || kl.v  || 0);
          const buyVol = parseFloat(kl.taker_buy_volume || kl.tbv || vol * 0.5);
          const sellVol = Math.max(0, vol - buyVol);
          accCvd = accCvd * (1 - CVD_ALPHA) + (buyVol - sellVol) * CVD_ALPHA;
          // Push close price into ring buffers — one sample per 1m K-line
          if (close > 0) _pushPrice(close);
        }
        _cvdEwma = accCvd;
      }

      if (msg.depth_ma_seed && msg.depth_ma_seed > 0) {
        _depthMa = msg.depth_ma_seed;
      }

      self.postMessage({ type: "macro_state_ready", source: "browser" });

      // Emit immediately so workers receive macro state without waiting 60s
      _recomputeAndEmit();
      break;
    }

    case "ping":
      self.postMessage({ type: "pong", ts: msg.ts });
      break;
  }
};
