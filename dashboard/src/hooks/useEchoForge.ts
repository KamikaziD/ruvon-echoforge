"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

// Derive WS base from NEXT_PUBLIC_BRIDGE_URL (the documented env var) so callers
// only need to set one variable. NEXT_PUBLIC_BRIDGE_WS can still override if needed.
function bridgeWsBase(): string {
  if (process.env.NEXT_PUBLIC_BRIDGE_WS) return process.env.NEXT_PUBLIC_BRIDGE_WS;
  const http = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "http://localhost:8765";
  return http.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}
const WS_BASE = bridgeWsBase();

// Reconnect backoff: 500ms → 1s → 2s → 4s → 8s (cap)
function nextBackoff(prev: number): number {
  return prev === 0 ? 500 : Math.min(prev * 2, 8_000);
}

// Close a socket and kill it if it's stuck in CONNECTING after timeoutMs
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Single hook that manages both WebSocket connections to the Python bridge:
 *   /api/v1/metrics  — 100ms push of node_metrics snapshots
 *   /api/v1/phic/ws  — live PHIC config pushes from server
 */
export function useEchoForge() {
  const metricsRef   = useRef<WebSocket | null>(null);
  const phicRef      = useRef<WebSocket | null>(null);
  // Throttle L2 depth updates to max 4/s — the book ticks faster than any human can read
  const l2PendingRef = useRef<{ bids: [number, number][]; asks: [number, number][] } | null>(null);
  const l2TimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const L2_THROTTLE_MS = 250;
  const {
    setConnected, setWsError,
    applyMetrics, setEchoes, pushAlert, setScoreTable, pushExecEvent,
    setPHIC, pushVPIN, setPortfolio, setHurdleSuggestions,
    pushEquity, pushRegime, setRegime, setHmmWarm, recordTrade, setL2Depth,
    pushOutcome, pushDriftAlert, bumpConfigVersion, setRegressionInsights,
    setMacroState,
    setDaemonWaitingForStart,
  } = useStore();

  // ── Metrics WebSocket ────────────────────────────────────────────────────
  useEffect(() => {
    let active  = true;
    let backoff = 0;
    let timer: ReturnType<typeof setTimeout>;
    let connectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!active) return;
      const ws = new WebSocket(`${WS_BASE}/api/v1/metrics`);
      metricsRef.current = ws;

      // Kill the socket if it stays in CONNECTING too long (e.g. bridge slow to accept)
      connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onclose = null;
          ws.close();
          if (active) { backoff = nextBackoff(backoff); timer = setTimeout(connect, backoff); }
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectTimer);
        backoff = 0;
        setConnected(true);
        setWsError(null);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          handleMetrics(msg);
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => setWsError(`Bridge unreachable — retrying (${WS_BASE})`);

      ws.onclose = () => {
        clearTimeout(connectTimer);
        setConnected(false);
        if (active) { backoff = nextBackoff(backoff); timer = setTimeout(connect, backoff); }
      };
    }

    // Defer past StrictMode's synchronous mount→unmount→remount cycle.
    timer = setTimeout(connect, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      const ws = metricsRef.current;
      if (ws) { ws.onclose = null; ws.close(); metricsRef.current = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PHIC WebSocket ───────────────────────────────────────────────────────
  useEffect(() => {
    let active  = true;
    let backoff = 0;
    let timer: ReturnType<typeof setTimeout>;
    let connectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!active) return;
      const ws = new WebSocket(`${WS_BASE}/api/v1/phic/ws`);
      phicRef.current = ws;

      connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onclose = null;
          ws.close();
          if (active) { backoff = nextBackoff(backoff); timer = setTimeout(connect, backoff); }
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearTimeout(connectTimer);
        backoff = 0;
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "phic_update" && msg.config) setPHIC(msg.config);
        } catch { /* ignore */ }
      };

      ws.onerror  = () => { /* onerror always fires before onclose; handled there */ };

      ws.onclose = () => {
        clearTimeout(connectTimer);
        if (active) { backoff = nextBackoff(backoff); timer = setTimeout(connect, backoff); }
      };
    }

    timer = setTimeout(connect, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(connectTimer);
      const ws = phicRef.current;
      if (ws) { ws.onclose = null; ws.close(); phicRef.current = null; }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Message handlers ─────────────────────────────────────────────────────

  function handleMetrics(msg: Record<string, unknown>) {
    switch (msg.type) {
      case "metrics_snapshot": {
        const m = msg as Record<string, unknown>;
        applyMetrics({
          vpin:                (m.vpin               as number) ?? 0,
          toxic:               (m.toxic              as boolean) ?? false,
          exchange_latency_ms: (m.exchange_latency_ms as number) ?? 0,
          is_passive:          (m.is_passive         as boolean) ?? false,
          peers:               (m.peers              as number) ?? 0,
          connected:           (m.connected          as boolean) ?? false,
          sovereign_node_id:   (m.sovereign_node_id  as string) ?? "—",
          is_sovereign:        (m.is_sovereign       as boolean) ?? true,
          s_ex:                (m.s_ex               as number) ?? 0,
          saf_pending:         (m.saf_pending        as number) ?? 0,
          success_rate:        (m.success_rate       as number) ?? 1.0,
          is_rate_limited:     (m.is_rate_limited    as boolean) ?? false,
          ...(typeof m.guardian_state === "string" ? { guardian_state: m.guardian_state as "NOMINAL" | "CAUTIOUS" | "REDUCE_ONLY" | "HALTED" } : {}),
          ...(typeof m.guardian_mode  === "string" ? { guardian_mode:  m.guardian_mode  as "shadow" | "active" } : {}),
        });
        if (typeof m.vpin === "number") pushVPIN(m.vpin as number);
        if (m.macro_state && typeof (m.macro_state as Record<string, unknown>).timestamp === "number") {
          setMacroState(m.macro_state as never);
        }
        break;
      }

      case "echo_snapshot":
        if (Array.isArray(msg.echoes)) setEchoes(msg.echoes as never);
        break;

      case "sentinel_alert":
        pushAlert({
          sentinel_type: msg.sentinel_type as never,
          action:        msg.action as string,
          severity:      msg.severity as number,
          detail:        msg.detail as string ?? "",
          timestamp:     msg.timestamp as number ?? Date.now(),
        });
        break;

      case "sovereign_update": {
        const scores = msg.score_table as Record<string, number> | undefined;
        if (scores) {
          const rows = Object.entries(scores).map(([node_id, s_ex]) => ({
            node_id,
            s_ex,
            latency_ms:  0,
            isSovereign: node_id === (msg.sovereign_node_id as string),
          }));
          setScoreTable(rows);
        }
        break;
      }

      case "order_submitted": {
        const price = msg.filled_price as number;
        const pnl   = msg.pnl_realized as number;
        const priceStr = price ? ` @$${price.toLocaleString()}` : "";
        const pnlStr   = (pnl && Math.abs(pnl) > 0.001)
          ? ` PnL=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`
          : "";
        pushExecEvent({
          pattern_id: msg.pattern_id as string,
          type:       "submitted",
          detail:     `${(msg.side as string).toUpperCase()} ${msg.qty} BTC${priceStr}${pnlStr}`,
          timestamp:  msg.timestamp as number ?? Date.now(),
        });
        if (msg.portfolio) {
          const { type: _t, timestamp: _ts, ...pf } = msg.portfolio as Record<string, unknown>;
          setPortfolio(pf as never);
          const tv = (pf as Record<string, unknown>).total_value as number | undefined;
          if (typeof tv === "number") pushEquity({ t: Date.now(), v: tv });
        }
        // Track win rate by pattern+regime
        if (msg.pnl_realized !== undefined && msg.pattern_id && msg.regime_tag) {
          recordTrade(msg.pattern_id as string, msg.regime_tag as string, (msg.pnl_realized as number) > 0);
        }
        break;
      }

      case "order_failed":
        pushExecEvent({
          pattern_id: msg.pattern_id as string,
          type:       "failed",
          detail:     msg.error as string ?? "unknown error",
          timestamp:  msg.timestamp as number ?? Date.now(),
        });
        break;

      case "saf_queued":
        pushExecEvent({
          pattern_id: msg.pattern_id as string,
          type:       "saf_queued",
          detail:     `SAF entry ${(msg.entry_id as string).slice(0, 8)}`,
          timestamp:  Date.now(),
        });
        break;

      case "portfolio_update": {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { type: _t, timestamp: _ts, ...portfolioFields } = msg;
        setPortfolio(portfolioFields as never);
        // Push equity curve point
        const tv = (portfolioFields as Record<string, unknown>).total_value as number | undefined;
        if (typeof tv === "number") pushEquity({ t: Date.now(), v: tv });
        break;
      }

      case "regime_change": {
        const r = (msg.regime_tag as string) ?? "LowVol";
        setRegime(r);
        pushRegime({ t: Date.now(), regime: r });
        break;
      }

      case "hmm_warm":
        setHmmWarm((msg.warm as boolean) ?? true);
        break;

      case "depth_update":
        if (msg.depth) {
          l2PendingRef.current = msg.depth as { bids: [number, number][]; asks: [number, number][] };
          if (!l2TimerRef.current) {
            l2TimerRef.current = setTimeout(() => {
              if (l2PendingRef.current) setL2Depth(l2PendingRef.current);
              l2PendingRef.current = null;
              l2TimerRef.current   = null;
            }, L2_THROTTLE_MS);
          }
        }
        break;

      case "hurdle_suggestion":
        setHurdleSuggestions(msg as never);
        break;

      case "phic_update":
        if (msg.config) {
          setPHIC(msg.config as never);
          const cfg = msg.config as Record<string, unknown>;
          const gm = cfg.guardian_mode as "shadow" | "active" | undefined;
          if (gm) applyMetrics({ guardian_mode: gm });
          if (cfg.execution_disabled === false) setDaemonWaitingForStart(false);
        }
        break;

      case "guardian_state":
        applyMetrics({
          guardian_state: (msg.state as "NOMINAL" | "CAUTIOUS" | "REDUCE_ONLY" | "HALTED") ?? "NOMINAL",
        });
        break;

      case "echo_pruned":
        pushAlert({
          sentinel_type: "Metabolic",
          severity:      0.2,
          action:        "PRUNED",
          detail:        `${msg.pruned_count} dead echo${(msg.pruned_count as number) === 1 ? "" : "s"} removed (>48h stale)`,
          timestamp:     Date.now(),
          node_id:       "local",
        } as never);
        break;

      case "outcome_recorded": {
        const p = (msg.payload ?? msg) as Record<string, unknown>;
        if (p.pattern_id) {
          pushOutcome({
            pattern_id:    p.pattern_id    as string,
            strategy_type: p.strategy_type as string ?? "momentum",
            regime_tag:    p.regime_tag    as string ?? "LowVol",
            outcome_score: p.outcome_score as number ?? 0,
            vpin:          p.vpin          as number | undefined,
            timestamp:     p.timestamp     as number ?? Date.now(),
          });
        }
        break;
      }

      case "drift_alert": {
        const p = (msg.payload ?? msg) as Record<string, unknown>;
        if (p.pattern_id) {
          pushDriftAlert({
            pattern_id:       p.pattern_id       as string,
            slope:            p.slope             as number ?? 0,
            r2:               p.r2                as number ?? 0,
            time_to_zero_min: p.time_to_zero_min  as number ?? 0,
            timestamp:        Date.now(),
          });
          pushAlert({
            sentinel_type: "Metabolic",
            severity:      0.5,
            action:        "DRIFT",
            detail:        `${p.pattern_id} edge decaying slope=${(p.slope as number)?.toFixed(5)} R²=${(p.r2 as number)?.toFixed(2)} → zero in ~${(p.time_to_zero_min as number)?.toFixed(0)}min`,
            timestamp:     Date.now(),
          } as never);
        }
        break;
      }

      case "regression_applied":
        if (msg.config) setPHIC(msg.config as never);
        bumpConfigVersion();
        break;

      case "regression_insights":
        if (msg.insights && typeof msg.insights === "object") {
          setRegressionInsights(msg.insights as Record<string, { r2: number; n: number; last_update_ms: number }>);
        }
        break;

      case "macro_state":
        if (msg.timestamp) setMacroState(msg as never);
        break;

      case "daemon_status":
        setDaemonWaitingForStart(msg.status === "WAITING_FOR_START");
        break;
    }
  }
}
