"""
Macro Market State Analyzer — Hurst persistence, CVD divergence, structural correlation.

Background asyncio task (bridge/main.py) calls compute_macro_state() every 60s and
broadcasts the result to all connected clients via broadcast_event().

Warm-start: on WARM_START_MACRO message the browser sends 3 days of 1-minute K-line
data; warm_start() pre-populates the ring buffers so the first compute_macro_state()
call has a full hour of price history with CVD and correlation seeded.

Four macro dimensions:
  1. Hurst persistence   — H > 0.55 = trending, H < 0.45 = reverting; 3600-sample @ 1s
  2. CVD divergence      — scipy.signal.find_peaks on 4h price + CVD series
  3. Structural corr     — BTC/ETH 1h Pearson < 0.40 = de-pegged
  4. Book depth density  — computed in browser macro_worker.js (depth stream access)
"""

import collections
import logging
import time
from typing import Optional

import numpy as np
from scipy.signal import find_peaks

logger = logging.getLogger(__name__)

# 1h price ring buffer: 3600 samples @ 1s.
# 512 @ 1s = only 8.5 min — too correlated with fast EMA filters, whipsaws on 15-min cycles.
HURST_BUFFER_SIZE = 3_600
HURST_MIN_SAMPLES = 60        # require at least 1 min before computing Hurst

# 4h CVD divergence buffers at 1s resolution
CVD_BUFFER_SIZE = 14_400      # 4h × 3600

# 1h structural correlation accumulation
CORR_BUFFER_SIZE = 3_600

# Hurst regime thresholds (overridden by PHIC at runtime)
H_TRENDING_DEFAULT  = 0.55
H_REVERTING_DEFAULT = 0.45


def _rs_hurst(prices: np.ndarray) -> Optional[float]:
    """
    Rescaled Range (R/S) Hurst exponent estimator.
    Returns H ∈ [0, 1] or None if insufficient or degenerate data.
    """
    n = len(prices)
    if n < HURST_MIN_SAMPLES:
        return None

    log_ret = np.diff(np.log(np.maximum(prices, 1e-10)))
    if len(log_ret) < 8:
        return None

    ns_log, rs_log = [], []
    for chunk in (len(log_ret) // 8, len(log_ret) // 4, len(log_ret) // 2, len(log_ret)):
        if chunk < 4:
            continue
        rs_vals = []
        for start in range(0, len(log_ret), chunk):
            seg = log_ret[start:start + chunk]
            if len(seg) < 4:
                continue
            dev = np.cumsum(seg - seg.mean())
            s   = seg.std(ddof=1)
            if s < 1e-12:
                continue
            rs_vals.append((dev.max() - dev.min()) / s)
        if rs_vals:
            ns_log.append(np.log(chunk))
            rs_log.append(np.log(np.mean(rs_vals)))

    if len(ns_log) < 2:
        return None

    ns_a, rs_a = np.array(ns_log), np.array(rs_log)
    n_pts = len(ns_a)
    denom = n_pts * (ns_a ** 2).sum() - ns_a.sum() ** 2
    if abs(denom) < 1e-12:
        return None
    slope = (n_pts * (ns_a * rs_a).sum() - ns_a.sum() * rs_a.sum()) / denom
    return float(np.clip(slope, 0.0, 1.0))


class MacroAnalyzer:
    """
    Bridges the gap between the 8ms VPIN regime and multi-hour structural market state.
    Designed as a background asyncio task (same pattern as DriftMonitor).
    """

    def __init__(self) -> None:
        # Hurst: (ts_s, price) ring buffer — 1s-rate-limited writes
        self._price_buf: collections.deque[tuple[float, float]] = collections.deque(
            maxlen=HURST_BUFFER_SIZE
        )
        self._last_sample_ts: float = 0.0

        # CVD divergence: parallel price + cvd_raw ring buffers — 1s-rate-limited
        self._cvd_price_buf: collections.deque[float] = collections.deque(maxlen=CVD_BUFFER_SIZE)
        self._cvd_raw_buf:   collections.deque[float] = collections.deque(maxlen=CVD_BUFFER_SIZE)
        self._cvd_ewma: float = 0.0    # running EWMA of (buy_vol − sell_vol)

        # BTC/ETH structural correlation
        self._corr_buf: collections.deque[float] = collections.deque(maxlen=CORR_BUFFER_SIZE)

        self._warm_start_complete: bool = False

        # PHIC thresholds — updated by main.py if bridge sends PHIC update
        self.h_trending:  float = H_TRENDING_DEFAULT
        self.h_reverting: float = H_REVERTING_DEFAULT

        # Last broadcast state (exposed for metrics_snapshot)
        self.last_state: dict = {
            "hurst": None, "persistence": "random",
            "cvd_div": "neutral", "correlation": "pegged",
            "macro_ready": False, "timestamp": 0,
        }

    # ── Live tick ingestion ─────────────────────────────────────────────────

    def add_tick(self, price: float, buy_vol: float, sell_vol: float,
                 ts: float | None = None) -> None:
        """
        Called on every market tick from tick.py.  Writes are 1s-rate-limited so the
        ring buffers reflect 1-second-sampled history, not raw tick density.
        """
        if price <= 0:
            return
        now = ts if ts is not None else time.time()
        self._cvd_ewma = self._cvd_ewma * 0.95 + (buy_vol - sell_vol) * 0.05

        if now - self._last_sample_ts >= 1.0:
            self._price_buf.append((now, price))
            self._cvd_price_buf.append(price)
            self._cvd_raw_buf.append(self._cvd_ewma)
            self._last_sample_ts = now

    def add_correlation_sample(self, pearson: float) -> None:
        """Accumulate BTC/ETH Pearson samples forwarded from correlation_worker via bridge."""
        if not (-1.0 <= pearson <= 1.0):
            return
        self._corr_buf.append(float(pearson))

    # ── Warm start ──────────────────────────────────────────────────────────

    def warm_start(self, btc_klines: list[dict], eth_klines: list[dict]) -> None:
        """
        Pre-populate ring buffers from 3-day 1m K-line history sent by the browser.
        Completes synchronously in milliseconds; called at most once per session.
        """
        if not btc_klines:
            logger.warning("MacroAnalyzer warm_start: no BTC K-lines provided")
            return

        logger.info("MacroAnalyzer warm_start: %d BTC K-lines, %d ETH K-lines",
                    len(btc_klines), len(eth_klines))

        btc_closes: list[float] = []
        btc_cvd_raws: list[float] = []
        cvd_acc = 0.0

        for kl in btc_klines:
            close   = float(kl.get("close") or kl.get("c") or 0)
            vol     = float(kl.get("volume") or kl.get("v") or 0)
            buy_vol = float(kl.get("taker_buy_volume") or kl.get("tbv") or vol * 0.5)
            if close <= 0:
                continue
            sell_vol = max(0.0, vol - buy_vol)
            cvd_acc  = cvd_acc * 0.95 + (buy_vol - sell_vol) * 0.05
            btc_closes.append(close)
            btc_cvd_raws.append(cvd_acc)

        now = time.time()

        # Populate Hurst ring buffer with most recent 3600 close prices.
        # Assign pseudo-timestamps spaced 60s apart (1m candles) so the 1s rate-limiter
        # doesn't drop them — warm-start bypasses the rate-limit directly.
        hurst_slice = btc_closes[-HURST_BUFFER_SIZE:]
        for i, p in enumerate(hurst_slice):
            pseudo_ts = now - (len(hurst_slice) - i) * 60
            self._price_buf.append((pseudo_ts, p))

        # Populate CVD divergence buffers with most recent 4h (240 × 1m candles)
        for p, c in zip(btc_closes[-240:], btc_cvd_raws[-240:]):
            self._cvd_price_buf.append(p)
            self._cvd_raw_buf.append(c)

        # Seed EWMA from last CVD entry so live ticks continue smoothly
        if btc_cvd_raws:
            self._cvd_ewma = btc_cvd_raws[-1]

        # Seed structural correlation from full 3-day BTC/ETH close price array
        if eth_klines:
            eth_closes = [
                float(kl.get("close") or kl.get("c") or 0)
                for kl in eth_klines
                if float(kl.get("close") or kl.get("c") or 0) > 0
            ]
            min_len = min(len(btc_closes), len(eth_closes), CORR_BUFFER_SIZE)
            if min_len >= 20:
                b_arr = np.array(btc_closes[-min_len:], dtype=np.float64)
                e_arr = np.array(eth_closes[-min_len:], dtype=np.float64)
                pearson = float(np.corrcoef(b_arr, e_arr)[0, 1])
                if not np.isnan(pearson):
                    self._corr_buf.append(pearson)

        self._warm_start_complete = True
        self._last_sample_ts = now
        logger.info(
            "MacroAnalyzer warm_start complete: Hurst buffer=%d  CVD buffer=%d",
            len(self._price_buf), len(self._cvd_price_buf),
        )

    # ── Computation ─────────────────────────────────────────────────────────

    def compute_hurst(self) -> Optional[float]:
        """R/S analysis on the 1h price ring buffer. Returns H or None."""
        if len(self._price_buf) < HURST_MIN_SAMPLES:
            return None
        prices = np.array([p for _, p in self._price_buf], dtype=np.float64)
        return _rs_hurst(prices)

    def compute_cvd_divergence(self) -> str:
        """
        Detect price/CVD divergence using scipy.signal.find_peaks with prominence
        filtering.  Prominence prevents false positives from brief local blips.
        Returns "bearish_div" | "bullish_div" | "neutral".
        """
        n = len(self._cvd_price_buf)
        if n < 60:
            return "neutral"

        price_arr = np.array(list(self._cvd_price_buf), dtype=np.float64)
        cvd_arr   = np.array(list(self._cvd_raw_buf),   dtype=np.float64)

        price_range = price_arr.max() - price_arr.min()
        cvd_scale   = np.abs(cvd_arr).max() * 2 + 1e-10
        if price_range < 1e-10:
            return "neutral"

        pn = (price_arr - price_arr.min()) / price_range  # normalised [0,1]
        cn = cvd_arr / cvd_scale                           # normalised around 0

        prom = 0.05  # 5% prominence — suppresses micro-blips while catching real peaks
        p_peaks,  _ = find_peaks( pn, prominence=prom)
        c_peaks,  _ = find_peaks( cn, prominence=prom)
        p_troughs,_ = find_peaks(-pn, prominence=prom)
        c_troughs,_ = find_peaks(-cn, prominence=prom)

        # Bearish divergence: price Higher High but CVD Lower High
        if len(p_peaks) >= 2 and len(c_peaks) >= 2:
            if pn[p_peaks[-1]] > pn[p_peaks[-2]] and cn[c_peaks[-1]] < cn[c_peaks[-2]]:
                return "bearish_div"

        # Bullish divergence: price Lower Low but CVD Higher Low
        if len(p_troughs) >= 2 and len(c_troughs) >= 2:
            if pn[p_troughs[-1]] < pn[p_troughs[-2]] and cn[c_troughs[-1]] > cn[c_troughs[-2]]:
                return "bullish_div"

        return "neutral"

    def compute_structural_correlation(self) -> str:
        """BTC/ETH mean Pearson < 0.40 → de-pegged (idiosyncratic flow)."""
        if len(self._corr_buf) < 5:
            return "pegged"
        mean_r = float(np.mean(list(self._corr_buf)))
        return "depegged" if mean_r < 0.40 else "pegged"

    def compute_macro_state(self) -> dict:
        """
        Assemble the full macro state vector.  Called every 60s from the bridge
        background task; result broadcast to all clients via broadcast_event().
        """
        hurst = self.compute_hurst()

        if hurst is None:
            persistence = "random"
        elif hurst > self.h_trending:
            persistence = "trending"
        elif hurst < self.h_reverting:
            persistence = "reverting"
        else:
            persistence = "random"

        state: dict = {
            "type":        "macro_state",
            "hurst":       round(hurst, 4) if hurst is not None else None,
            "persistence": persistence,
            "cvd_div":     self.compute_cvd_divergence(),
            "correlation": self.compute_structural_correlation(),
            "macro_ready": self._warm_start_complete,
            "hurst_buf_n": len(self._price_buf),
            "cvd_buf_n":   len(self._cvd_price_buf),
            "timestamp":   int(time.time() * 1000),
        }
        self.last_state = state
        return state
