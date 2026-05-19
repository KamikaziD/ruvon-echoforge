import { DistributionResult, OutcomeRecord } from "@/lib/store";

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (p / 100) * (n - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.min(lo + 1, n - 1);
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

export function computeDistributions(
  outcomes: OutcomeRecord[],
): Record<string, DistributionResult> {
  const groups: Record<string, number[]> = {};
  for (const o of outcomes) {
    const key = `${o.pattern_id}:${o.regime_tag}`;
    (groups[key] ??= []).push(o.outcome_score);
  }
  const result: Record<string, DistributionResult> = {};
  for (const [key, scores] of Object.entries(groups)) {
    if (scores.length < 3) continue;
    const sorted   = [...scores].sort((a, b) => a - b);
    const n        = sorted.length;
    const mean     = scores.reduce((s, v) => s + v, 0) / n;
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std      = Math.sqrt(variance) || 1e-9;
    const median   = percentile(sorted, 50);
    const q1       = percentile(sorted, 25);
    const q3       = percentile(sorted, 75);
    const iqr      = q3 - q1;
    const wLo      = q1 - 1.5 * iqr;
    const wHi      = q3 + 1.5 * iqr;
    const outliers  = sorted.filter((v) => v < wLo || v > wHi);
    const whiskerLo = sorted.find((v) => v >= wLo) ?? sorted[0];
    const whiskerHi = [...sorted].reverse().find((v) => v <= wHi) ?? sorted[n - 1];
    result[key] = {
      count:       n,
      reliability: n >= 30 ? "high" : n >= 10 ? "medium" : "low",
      mean, median, q1, q3, iqr, std,
      whiskers:    { lo: whiskerLo, hi: whiskerHi },
      outliers,
      skewness:    3 * (mean - median) / std,
      consistency: median / Math.max(iqr, 0.01),
      wins:        scores.filter((s) => s > 0).length,
    };
  }
  return result;
}
