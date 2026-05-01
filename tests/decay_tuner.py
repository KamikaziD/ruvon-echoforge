"""
Decay Tuner — grid search over Bayesian aliveness decay parameters.

Simulates the echo aliveness model from echoforge_worker.js against
a real session export, finding (decay_rate, loss_multiplier) pairs that
maximise Sharpe ratio while keeping echo survival above a floor.

The model exactly mirrors echoforge_worker.js:
    # On signal pass:
    aliveness = min(1.0, aliveness + SIGNAL_BOOST)

    # On execution result:
    normalised = (outcome_score + 1.0) / 2.0          # [-1,1] → [0,1]
    alpha      = decay_rate * loss_multiplier if outcome_score < 0 else decay_rate
    alpha      = min(alpha, 1.0)
    aliveness  = clamp(aliveness * (1 - alpha) + normalised * alpha, 0, 1)

Output: ranked table + best params printed, optionally saved as JSON.

Usage:
    python -m ruvon_echoforge.tests.decay_tuner session_export.json
    python -m ruvon_echoforge.tests.decay_tuner session_export.json --out tuner_results.json
    python -m ruvon_echoforge.tests.decay_tuner session_export.json \\
        --decay-range 0.005 0.20 12 \\
        --loss-range  2.0   10.0 12 \\
        --survival-floor 0.30
"""

import argparse
import json
import math
import sys
from dataclasses import dataclass
from itertools import product
from pathlib import Path
from typing import Any


# ── Constants (must match echoforge_worker.js) ─────────────────────────────

MIN_ALIVENESS = 0.30    # hibernation threshold
SIGNAL_BOOST  = 0.03    # aliveness bump per signal pass


# ── Aliveness simulation (EWMA — mirrors _onSignalPass + _onExecutionResult) ─

@dataclass
class SimResult:
    decay_rate:      float
    loss_multiplier: float
    sharpe:          float
    win_rate:        float
    pass_rate:       float
    echo_survival:   float
    executions:      int


def _simulate(
    decisions:       list[dict],
    outcomes:        list[dict],
    decay_rate:      float,
    loss_multiplier: float,
) -> SimResult:
    """
    Replay decisions + outcomes to measure signal quality under the given params.

    Each decision that passes the metabolic filter counts as a signal_pass event.
    The first outcome matching a pattern_id is treated as its execution_result.
    """
    # Build outcome sequence in order so each outcome is consumed once
    outcome_queue: list[tuple[str, float]] = [
        (o["pattern_id"], float(o["outcome_score"]))
        for o in outcomes
        if "pattern_id" in o and "outcome_score" in o
    ]
    # Map pattern_id → remaining outcomes (FIFO)
    from collections import defaultdict, deque
    outcome_fifo: dict[str, deque] = defaultdict(deque)
    for pid, score in outcome_queue:
        outcome_fifo[pid].append(score)

    aliveness = 0.50
    scores: list[float] = []
    passed  = 0
    dropped = 0

    for d in decisions:
        if d.get("result") != "pass":
            dropped += 1
            continue

        # Signal pass: small aliveness boost (mirrors _onSignalPass SIGNAL_BOOST)
        aliveness = min(1.0, aliveness + SIGNAL_BOOST)

        if aliveness < MIN_ALIVENESS:
            dropped += 1
            continue

        passed += 1
        pid = d.get("pattern_id")

        if pid and outcome_fifo[pid]:
            outcome_score = outcome_fifo[pid].popleft()
            scores.append(outcome_score)

            # EWMA update (mirrors _onExecutionResult)
            normalised = (outcome_score + 1.0) / 2.0
            alpha = min(decay_rate * loss_multiplier, 1.0) if outcome_score < 0 else decay_rate
            aliveness = max(0.0, min(1.0, aliveness * (1 - alpha) + normalised * alpha))

    total     = passed + dropped
    pass_rate = passed / total if total > 0 else 0.0
    win_rate  = sum(1 for s in scores if s > 0) / len(scores) if scores else 0.0
    mean      = sum(scores) / len(scores) if scores else 0.0
    var       = sum((s - mean) ** 2 for s in scores) / len(scores) if scores else 0.0
    sharpe    = mean / math.sqrt(var) if var > 0 else 0.0

    return SimResult(
        decay_rate=decay_rate,
        loss_multiplier=loss_multiplier,
        sharpe=sharpe,
        win_rate=win_rate,
        pass_rate=pass_rate,
        echo_survival=float(aliveness >= MIN_ALIVENESS),
        executions=len(scores),
    )


# ── Grid search ────────────────────────────────────────────────────────────

def linspace(lo: float, hi: float, n: int) -> list[float]:
    if n == 1:
        return [lo]
    step = (hi - lo) / (n - 1)
    return [round(lo + step * i, 6) for i in range(n)]


def grid_search(
    decisions:      list[dict],
    outcomes:       list[dict],
    decay_range:    tuple[float, float, int],
    loss_range:     tuple[float, float, int],
    survival_floor: float,
) -> list[SimResult]:
    decay_vals  = linspace(*decay_range)
    loss_vals   = linspace(*loss_range)
    total_cells = len(decay_vals) * len(loss_vals)

    results = []
    done    = 0
    for dr, lm in product(decay_vals, loss_vals):
        results.append(_simulate(decisions, outcomes, dr, lm))
        done += 1
        if done % max(1, total_cells // 20) == 0:
            print(f"  grid search: {done}/{total_cells} ({done/total_cells:.0%})  …",
                  end="\r", flush=True)

    print(f"  grid search: {total_cells}/{total_cells} (100%)       ")

    viable = [r for r in results if r.echo_survival >= survival_floor and r.executions > 0]
    if not viable:
        viable = [r for r in results if r.executions > 0] or results

    viable.sort(key=lambda r: r.sharpe, reverse=True)
    return viable


# ── Reporting ──────────────────────────────────────────────────────────────

def print_table(results: list[SimResult], top_n: int = 10):
    rows   = results[:top_n]
    header = (f"{'decay_rate':>12}  {'loss_mult':>9}  {'sharpe':>8}  "
              f"{'win_rate':>8}  {'pass_rate':>9}  {'survival':>8}  {'execs':>6}")
    print("\n── Top Results ──────────────────────────────────────────────────────────")
    print(header)
    print("─" * len(header))
    for r in rows:
        print(f"  {r.decay_rate:>10.5f}  {r.loss_multiplier:>9.3f}  {r.sharpe:>8.4f}  "
              f"{r.win_rate:>7.2%}  {r.pass_rate:>8.2%}  {r.echo_survival:>8.2%}  {r.executions:>6}")
    print("─────────────────────────────────────────────────────────────────────────")


def print_best(best: SimResult):
    print(f"""
── Best Parameters ──────────────────────────────────────────────────────────
  DEFAULT_DECAY_RATE     = {best.decay_rate}
  LOSS_DECAY_MULTIPLIER  = {best.loss_multiplier}

  Sharpe                 = {best.sharpe:.4f}
  Win rate               = {best.win_rate:.2%}
  Pass rate              = {best.pass_rate:.2%}
  Echo survival          = {best.echo_survival:.2%}
  Executions in session  = {best.executions}
─────────────────────────────────────────────────────────────────────────────

To apply, update echoforge_worker.js:
  const DEFAULT_DECAY_RATE     = {best.decay_rate};
  const LOSS_DECAY_MULTIPLIER  = {best.loss_multiplier};

Or push via PHIC (no code change needed):
  _applyPHIC({{ decay_rate: {best.decay_rate}, loss_multiplier: {best.loss_multiplier} }})
""")


# ── Entry point ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="EchoForge Decay Tuner")
    parser.add_argument("session_file",    type=Path,
                        help="session_recorder.js export JSON")
    parser.add_argument("--decay-range",   type=float, nargs=3,
                        default=[0.005, 0.20, 12],
                        metavar=("LO", "HI", "N"),
                        help="decay_rate grid (default 0.005 0.20 12)")
    parser.add_argument("--loss-range",    type=float, nargs=3,
                        default=[2.0, 10.0, 12],
                        metavar=("LO", "HI", "N"),
                        help="loss_multiplier grid (default 2.0 10.0 12)")
    parser.add_argument("--survival-floor",type=float, default=0.30,
                        help="Minimum echo_survival fraction (default 0.30)")
    parser.add_argument("--top",           type=int, default=10,
                        help="Rows to show in table (default 10)")
    parser.add_argument("--out",           type=Path, default=None,
                        help="Save full results as JSON")
    args = parser.parse_args()

    if not args.session_file.exists():
        print(f"File not found: {args.session_file}", file=sys.stderr)
        sys.exit(1)

    with open(args.session_file) as f:
        session = json.load(f)

    decisions = session.get("decisions", [])
    outcomes  = session.get("outcomes",  [])

    print(f"Session: {session.get('session_id', 'n/a')[:16]}…")
    print(f"  decisions={len(decisions)}  outcomes={len(outcomes)}")

    if not decisions:
        print("No decisions in session — nothing to tune.", file=sys.stderr)
        sys.exit(1)

    decay_range = (args.decay_range[0], args.decay_range[1], int(args.decay_range[2]))
    loss_range  = (args.loss_range[0],  args.loss_range[1],  int(args.loss_range[2]))

    n_cells = int(decay_range[2]) * int(loss_range[2])
    print(f"\nGrid: {int(decay_range[2])} × {int(loss_range[2])} = {n_cells} cells\n")

    results = grid_search(decisions, outcomes, decay_range, loss_range, args.survival_floor)

    print_table(results, top_n=args.top)
    if results:
        print_best(results[0])

    if args.out and results:
        out_data: list[dict[str, Any]] = [
            {
                "decay_rate":      r.decay_rate,
                "loss_multiplier": r.loss_multiplier,
                "sharpe":          round(r.sharpe, 6),
                "win_rate":        round(r.win_rate, 6),
                "pass_rate":       round(r.pass_rate, 6),
                "echo_survival":   round(r.echo_survival, 6),
                "executions":      r.executions,
            }
            for r in results
        ]
        with open(args.out, "w") as f:
            json.dump({"session_id": session.get("session_id"), "results": out_data}, f, indent=2)
        print(f"Full results saved to {args.out}")


if __name__ == "__main__":
    main()
