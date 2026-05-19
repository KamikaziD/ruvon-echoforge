"""
Drift Monitor — detects decaying edge via OLS regression on per-pattern outcome history.

Usage:
    monitor = DriftMonitor()
    monitor.add_outcome("REVERSION_A", outcome_score=0.42, timestamp=1715638920410)
    alerts = monitor.check_drift()   # returns list[DriftAlert] when slope < threshold

DriftMonitor is designed to run in an asyncio background task (see bridge/main.py).
All methods are synchronous and thread-safe by GIL; no external dependencies required.
"""

import collections
import math
import time
from dataclasses import dataclass, asdict


# ── OLS helpers ───────────────────────────────────────────────────────────────

def _linregress(xs: list[float], ys: list[float]) -> tuple[float, float, float, float]:
    """Return (slope, intercept, r_squared, se_slope) via OLS. Pure Python, no numpy required.

    se_slope is the standard error of the slope estimate (σ/√S_xx * √MSE).
    The 95% CI on the slope is  slope ± 1.96 * se_slope.
    """
    n = len(xs)
    sx  = sum(xs)
    sy  = sum(ys)
    sxy = sum(x * y for x, y in zip(xs, ys))
    sxx = sum(x * x for x in xs)
    syy = sum(y * y for y in ys)

    denom_x = n * sxx - sx * sx   # = n · S_xx
    denom_y = n * syy - sy * sy   # = n · S_yy
    if denom_x == 0:
        return 0.0, (sy / n if n else 0.0), 0.0, math.inf

    slope     = (n * sxy - sx * sy) / denom_x
    intercept = (sy - slope * sx) / n
    r2_num    = (n * sxy - sx * sy) ** 2
    r2        = r2_num / (denom_x * denom_y) if denom_y > 0 else 0.0

    # SE(slope) = sqrt(MSE / S_xx)
    s_xx   = denom_x / n
    s_xy   = (n * sxy - sx * sy) / n
    s_yy   = denom_y / n
    ss_res = max(0.0, s_yy - slope * s_xy)   # residual sum of squares
    mse    = ss_res / max(n - 2, 1)
    se_slope = math.sqrt(mse / s_xx) if s_xx > 0 else math.inf

    return slope, intercept, max(0.0, min(1.0, r2)), se_slope


# ── Public types ──────────────────────────────────────────────────────────────

@dataclass
class DriftAlert:
    pattern_id:       str
    slope:            float
    r2:               float
    se_slope:         float   # standard error of slope estimate
    ci95_upper:       float   # slope + 1.96*se_slope — upper bound of 95% CI
    time_to_zero_min: float
    timestamp:        int

    def to_dict(self) -> dict:
        d = asdict(self)
        d["id"] = f"{self.pattern_id}_{self.timestamp}"
        return d


# ── Core class ────────────────────────────────────────────────────────────────

class DriftMonitor:
    """
    Buffers outcome_score history per pattern and fires DriftAlerts when a
    statistically significant negative trend is detected.

    Regression x-axis is outcome index (0, 1, 2 …) so slope is in
    "score per outcome" units — directly interpretable as edge decay rate.
    time_to_zero_min is derived from slope and the observed inter-outcome interval.

    Parameters
    ----------
    window          Rolling buffer size per pattern (default 100).
    slope_threshold Alert fires when slope < this value (default -0.002/outcome).
    r2_min          Minimum R² required to fire (default 0.50).
    cooldown_min    Minimum minutes between alerts for the same pattern (default 15).
    min_samples     Minimum buffered outcomes before regression is attempted (default 20).
    """

    def __init__(
        self,
        window:          int   = 100,
        slope_threshold: float = -0.002,
        r2_min:          float = 0.50,
        cooldown_min:    float = 15.0,
        min_samples:     int   = 20,
    ) -> None:
        self._buffer:     dict[str, list[tuple[float, float]]] = collections.defaultdict(list)
        self._last_alert: dict[str, float] = {}
        self._window          = window
        self._slope_threshold = slope_threshold
        self._r2_min          = r2_min
        self._cooldown_ms     = cooldown_min * 60_000
        self._min_samples     = min_samples

    # ── Ingestion ─────────────────────────────────────────────────────────────

    def add_outcome(
        self,
        pattern_id:    str,
        outcome_score: float,
        timestamp:     int | None = None,
    ) -> None:
        """Buffer one outcome. timestamp is epoch-ms; defaults to now."""
        ts  = float(timestamp if timestamp is not None else time.time() * 1000)
        buf = self._buffer[pattern_id]
        buf.append((ts, outcome_score))
        if len(buf) > self._window:
            buf.pop(0)

    # ── Detection ─────────────────────────────────────────────────────────────

    def check_drift(self) -> list[DriftAlert]:
        """
        Run OLS regression over each pattern's rolling buffer.
        x = outcome index (0,1,2…), so slope is score-per-outcome.
        Returns alerts for patterns where slope < threshold and R² > r2_min,
        subject to per-pattern cooldown.
        """
        alerts: list[DriftAlert] = []
        now_ms = time.time() * 1000

        for pid, history in self._buffer.items():
            n = len(history)
            if n < self._min_samples:
                continue
            if now_ms - self._last_alert.get(pid, 0.0) < self._cooldown_ms:
                continue

            xs = list(range(n))               # index-based: slope = Δscore / outcome
            ys = [h[1] for h in history]

            slope, intercept, r2, se_slope = _linregress(xs, ys)
            ci95_upper = slope + 1.96 * se_slope  # upper bound of 95% CI on slope

            # Require: point estimate below threshold, R² above floor, AND the
            # upper CI bound is still negative — so even the optimistic reading
            # of the slope confirms a declining edge (not just sampling noise).
            if slope >= self._slope_threshold or r2 < self._r2_min or ci95_upper >= 0:
                continue

            mean_y = sum(ys) / n
            # outcomes_to_zero: how many more outcomes until projected mean hits 0
            if slope < 0 and mean_y > 0:
                outcomes_to_zero = abs(mean_y / slope)
                # convert to minutes using observed inter-outcome interval
                if n >= 2:
                    span_ms       = history[-1][0] - history[0][0]
                    ms_per_outcome = span_ms / (n - 1)
                else:
                    ms_per_outcome = 60_000  # assume 1/min fallback
                time_to_zero_min = outcomes_to_zero * ms_per_outcome / 60_000
            elif mean_y <= 0:
                time_to_zero_min = 0.0
            else:
                time_to_zero_min = math.inf

            self._last_alert[pid] = now_ms
            alerts.append(DriftAlert(
                pattern_id=pid,
                slope=round(slope, 6),
                r2=round(r2, 4),
                se_slope=round(se_slope, 6),
                ci95_upper=round(ci95_upper, 6),
                time_to_zero_min=round(min(time_to_zero_min, 9999.0), 1),
                timestamp=int(now_ms),
            ))

        return alerts

    # ── Diagnostics ───────────────────────────────────────────────────────────

    def buffer_stats(self) -> dict[str, int]:
        """Return {pattern_id: sample_count} for observability."""
        return {pid: len(buf) for pid, buf in self._buffer.items()}
