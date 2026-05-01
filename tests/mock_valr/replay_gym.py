"""
L2 Replay Gym — feed a recorded session export back through the mock VALR server.

Loads the JSON produced by `window.exportSession()` (session_recorder.js),
extracts tick data, and POSTs it to the mock server's /mock/replay endpoint.
Progress is polled until done, then session stats are printed.

Usage:
    python -m ruvon_echoforge.tests.mock_valr.replay_gym session_export.json
    python -m ruvon_echoforge.tests.mock_valr.replay_gym session_export.json --speed 5 --server http://localhost:8766
    python -m ruvon_echoforge.tests.mock_valr.replay_gym session_export.json --dry-run
"""

import argparse
import json
import sys
import time
from pathlib import Path

try:
    import httpx
except ImportError:
    print("httpx required: pip install httpx", file=sys.stderr)
    sys.exit(1)


def load_session(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def ticks_from_session(session: dict) -> list[dict]:
    """Extract tick records from a session_recorder.js export."""
    ticks = session.get("ticks", [])
    if not ticks:
        raise ValueError("Session export contains no tick records.")
    return ticks


def build_replay_payload(ticks: list[dict], speed: float, pair: str) -> dict:
    replay_ticks = []
    for t in ticks:
        price = t.get("price")
        quantity = t.get("volume") or t.get("quantity") or t.get("qty")
        side = t.get("side") or t.get("takerSide") or "buy"
        traded_at = t.get("tradedAt") or t.get("timestamp_iso")

        # Timestamp might be epoch ms — convert to ISO if needed
        if traded_at is None:
            ts_ms = t.get("timestamp") or t.get("ts")
            if ts_ms:
                from datetime import datetime, timezone
                dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
                traded_at = dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            else:
                from datetime import datetime, timezone
                traded_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        if price is None or quantity is None:
            continue  # skip incomplete ticks

        replay_ticks.append({
            "price":     float(price),
            "quantity":  float(quantity),
            "takerSide": str(side),
            "tradedAt":  str(traded_at),
        })

    if not replay_ticks:
        raise ValueError("No valid tick records found after parsing.")

    return {"ticks": replay_ticks, "speed": speed, "pair": pair}


def poll_progress(client: httpx.Client, server: str, total: int):
    bar_width = 40
    while True:
        try:
            r = client.get(f"{server}/mock/replay/status", timeout=5)
            s = r.json()
        except Exception as e:
            print(f"\nPoll error: {e}", file=sys.stderr)
            time.sleep(1)
            continue

        played   = s.get("played", 0)
        finished = s.get("finished", False)
        running  = s.get("running", True)
        progress = s.get("progress", 0.0)

        filled = int(bar_width * progress)
        bar    = "█" * filled + "░" * (bar_width - filled)
        print(f"\r  [{bar}] {played}/{total} ({progress*100:.1f}%)  ", end="", flush=True)

        if finished or (not running and played >= total):
            print()  # newline after bar
            return s

        time.sleep(0.5)


def print_stats(session: dict):
    decisions = session.get("decisions", [])
    outcomes  = session.get("outcomes", [])
    events    = session.get("events", [])
    ticks     = session.get("ticks", [])

    executed = [o for o in outcomes if o.get("outcome_score") is not None]
    wins     = [o for o in executed if o["outcome_score"] > 0]
    win_rate = len(wins) / len(executed) if executed else 0.0

    scores  = [o["outcome_score"] for o in executed]
    mean    = sum(scores) / len(scores) if scores else 0.0
    var     = sum((s - mean) ** 2 for s in scores) / len(scores) if scores else 0.0
    sharpe  = mean / (var ** 0.5) if var > 0 else 0.0

    passed  = sum(1 for d in decisions if d.get("result") == "pass")
    dropped = sum(1 for d in decisions if d.get("result") != "pass")

    sentinels = [e for e in events if e.get("kind") == "sentinel_alert"]
    by_type   = {}
    for s in sentinels:
        k = s.get("sentinel_type", "unknown")
        by_type[k] = by_type.get(k, 0) + 1

    print("\n── Session Replay Stats ─────────────────────────────")
    print(f"  Session ID : {session.get('session_id', 'n/a')[:16]}…")
    print(f"  Ticks      : {len(ticks)}")
    print(f"  Signals    : {passed} passed / {dropped} dropped  (pass rate {passed/((passed+dropped) or 1):.2%})")
    print(f"  Executions : {len(executed)}  |  Win rate: {win_rate:.2%}  |  Sharpe: {sharpe:.4f}")
    if by_type:
        print(f"  Sentinels  : {', '.join(f'{k}×{v}' for k, v in sorted(by_type.items()))}")
    print("─────────────────────────────────────────────────────")


def main():
    parser = argparse.ArgumentParser(description="L2 Replay Gym")
    parser.add_argument("session_file",  type=Path, help="Path to session_recorder.js export JSON")
    parser.add_argument("--speed",       type=float, default=1.0, help="Replay speed multiplier (default 1.0)")
    parser.add_argument("--pair",        default="BTCUSDT", help="Currency pair label (default BTCUSDT)")
    parser.add_argument("--server",      default="http://localhost:8766", help="Mock VALR server URL")
    parser.add_argument("--dry-run",     action="store_true", help="Parse and validate without sending")
    args = parser.parse_args()

    if not args.session_file.exists():
        print(f"File not found: {args.session_file}", file=sys.stderr)
        sys.exit(1)

    print(f"Loading session: {args.session_file}")
    session = load_session(args.session_file)
    ticks   = ticks_from_session(session)
    payload = build_replay_payload(ticks, args.speed, args.pair)

    print(f"  {len(payload['ticks'])} ticks  |  {args.speed}× speed  |  pair={args.pair}")

    if args.dry_run:
        print_stats(session)
        print("\nDry run — no data sent to server.")
        return

    with httpx.Client() as client:
        # Verify server is reachable
        try:
            client.get(f"{args.server}/mock/state", timeout=3)
        except Exception as e:
            print(f"Cannot reach mock server at {args.server}: {e}", file=sys.stderr)
            sys.exit(1)

        print(f"\nStarting replay on {args.server} …")
        r = client.post(f"{args.server}/mock/replay", json=payload, timeout=10)
        r.raise_for_status()
        resp = r.json()
        total = resp.get("total", len(payload["ticks"]))
        print(f"  Server ack: {resp}")

        print()
        final = poll_progress(client, args.server, total)
        print(f"  Replay complete: {final.get('played')}/{final.get('total')} ticks")

    print_stats(session)


if __name__ == "__main__":
    main()
