"use client";

import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";

const WS_BASE = process.env.NEXT_PUBLIC_BRIDGE_WS ?? "ws://localhost:8765";

/**
 * Single hook that manages both WebSocket connections to the Python bridge:
 *   /api/v1/metrics  — 100ms push of node_metrics snapshots
 *   /api/v1/phic/config (WS) — live PHIC updates pushed from server
 */
export function useEchoForge() {
  const metricsRef = useRef<WebSocket | null>(null);
  const phicRef    = useRef<WebSocket | null>(null);
  const {
    setConnected, setWsError,
    applyMetrics, setEchoes, pushAlert, setScoreTable, pushExecEvent,
    setPHIC, pushVPIN, setPortfolio, setHurdleSuggestions,
    pushEquity, pushRegime, setRegime, setHmmWarm, recordTrade, setL2Depth,
  } = useStore();

  // ── Metrics WebSocket ────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!active) return;
      const ws = new WebSocket(`${WS_BASE}/api/v1/metrics`);
      metricsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setWsError(null);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          handleMetrics(msg);
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => setWsError("Metrics socket error");

      ws.onclose = () => {
        setConnected(false);
        if (active) timer = setTimeout(connect, 3000);
      };
    }

    // Defer past StrictMode's synchronous mount→unmount→remount cycle.
    // If cleanup fires before this tick, clearTimeout cancels it and no socket is ever created.
    timer = setTimeout(connect, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      const ws = metricsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        metricsRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── PHIC WebSocket ───────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      if (!active) return;
      const ws = new WebSocket(`${WS_BASE}/api/v1/phic/ws`);
      phicRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "phic_update" && msg.config) {
            setPHIC(msg.config);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => {
        if (active) timer = setTimeout(connect, 5000);
      };
    }

    timer = setTimeout(connect, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      const ws = phicRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        phicRef.current = null;
      }
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
        });
        if (typeof m.vpin === "number") pushVPIN(m.vpin as number);
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
          setL2Depth(msg.depth as { bids: [number, number][]; asks: [number, number][] });
        }
        break;

      case "hurdle_suggestion":
        setHurdleSuggestions(msg as never);
        break;

      case "phic_update":
        if (msg.config) setPHIC(msg.config as never);
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
    }
  }
}
