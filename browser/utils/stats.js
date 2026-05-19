/**
 * stats.js — Distribution math engine for EchoForge pattern validation.
 *
 * calculateDistribution(values) → DistributionResult
 *   Full statistical summary with Tukey fences, Pearson median skewness,
 *   and a Low-n reliability guard. Designed to be called on outcome_score
 *   arrays grouped by (pattern_id, regime_tag) so the decay tuner and
 *   dashboard can reason about consistency, not just averages.
 *
 * Interpretation guide:
 *   reliability='low'       n<10  — don't act on this
 *   reliability='medium'    n<30  — directionally useful, not production-ready
 *   reliability='high'      n≥30  — safe to tune parameters from
 *
 *   iqr near 0              Consistent; system behaves predictably in this regime
 *   iqr > 0.5 (wide)        High variance; regime or VPIN sensitivity — check outliers
 *   skewness > 0            Right-skewed: wins are larger than losses (good)
 *   skewness < 0            Left-skewed: fat loss tail — revisit loss_multiplier or veto pattern
 */

"use strict";

/**
 * @typedef {Object} DistributionResult
 * @property {number}   count       - Number of observations
 * @property {string}   reliability - 'high' (n≥30) | 'medium' (n≥10) | 'low' (n<10)
 * @property {number}   mean        - Arithmetic mean
 * @property {number}   median      - 50th percentile
 * @property {number}   q1          - 25th percentile
 * @property {number}   q3          - 75th percentile
 * @property {number}   iqr         - q3 − q1
 * @property {{lo:number,hi:number}} whiskers - Tukey inner fences (Q1−1.5·IQR, Q3+1.5·IQR)
 * @property {number[]} outliers    - Values outside Tukey fences
 * @property {number}   skewness    - Pearson median skewness: 3(mean−median)/σ
 * @property {number}   std         - Population standard deviation
 * @property {number}   consistency - Median / max(IQR, 0.01) — higher = better risk-adjusted consistency
 */

/**
 * Compute the full distribution summary for an array of numeric values.
 * Returns null for an empty array; guards against NaN in inputs.
 *
 * @param {number[]} values
 * @returns {DistributionResult|null}
 */
export function calculateDistribution(values) {
  const clean = values.filter(v => typeof v === "number" && isFinite(v));
  const n = clean.length;
  if (n === 0) return null;

  const reliability = n >= 30 ? "high" : n >= 10 ? "medium" : "low";

  const sorted = [...clean].sort((a, b) => a - b);

  const mean   = clean.reduce((s, v) => s + v, 0) / n;
  const median = _percentile(sorted, 0.50);
  const q1     = _percentile(sorted, 0.25);
  const q3     = _percentile(sorted, 0.75);
  const iqr    = q3 - q1;

  // Tukey inner fences — standard box plot whiskers
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const outliers = sorted.filter(v => v < loFence || v > hiFence);

  // Population std (not sample) — consistent with Sharpe calculations elsewhere
  const variance = clean.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const std      = Math.sqrt(variance);

  // Pearson median skewness: positive = right tail (wins bigger than losses)
  const skewness = std > 0 ? 3 * (mean - median) / std : 0;

  // Consistency score: reward high median and low IQR. Clamp IQR floor to 0.01
  // to avoid division-by-zero on perfectly constant series.
  const consistency = median / Math.max(iqr, 0.01);

  return {
    count:       n,
    reliability,
    mean:        +mean.toFixed(6),
    median:      +median.toFixed(6),
    q1:          +q1.toFixed(6),
    q3:          +q3.toFixed(6),
    iqr:         +iqr.toFixed(6),
    whiskers:    { lo: +loFence.toFixed(6), hi: +hiFence.toFixed(6) },
    outliers:    outliers.map(v => +v.toFixed(6)),
    skewness:    +skewness.toFixed(4),
    std:         +std.toFixed(6),
    consistency: +consistency.toFixed(4),
  };
}

/**
 * Group an array of outcome records by (pattern_id, regime_tag) and compute
 * the distribution summary for each group's outcome_score.
 *
 * Returns a map: `"PATTERN_ID:REGIME"` → DistributionResult | null
 *
 * @param {Array<{pattern_id:string, regime_tag?:string, outcome_score:number}>} outcomes
 * @returns {Object.<string, DistributionResult|null>}
 */
export function groupDistributions(outcomes) {
  const groups = {};
  for (const o of outcomes) {
    const pid    = o.pattern_id;
    const regime = o.regime_tag ?? "Any";
    const score  = o.outcome_score;
    if (!pid || typeof score !== "number") continue;

    const key = `${pid}:${regime}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(score);
  }

  const result = {};
  for (const [key, scores] of Object.entries(groups)) {
    result[key] = calculateDistribution(scores);
  }
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Interpolated percentile on a pre-sorted array (linear interpolation).
 */
function _percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];

  const idx  = p * (n - 1);
  const lo   = Math.floor(idx);
  const hi   = Math.ceil(idx);
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
