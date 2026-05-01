"use client";

import { useEffect } from "react";
import { useEchoForge } from "@/hooks/useEchoForge";
import { useStore } from "@/lib/store";
import { SyndicateHealth } from "@/components/panels/SyndicateHealth";
import { ActiveEchoes }    from "@/components/panels/ActiveEchoes";
import { SentinelAlerts }  from "@/components/panels/SentinelAlerts";
import { ExecutionLog }    from "@/components/panels/ExecutionLog";
import { PHICControls }    from "@/components/PHICControls";
import { fetchPHIC }       from "@/lib/api";
import { Hexagon, WifiOff } from "lucide-react";

function ConnectionBanner() {
  const { connected, wsError } = useStore((s) => ({ connected: s.connected, wsError: s.wsError }));
  if (connected) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-red-950/40 border-b border-red-900/40 text-xs text-red-400">
      <WifiOff size={11} />
      <span>Bridge offline — reconnecting to {process.env.NEXT_PUBLIC_BRIDGE_WS ?? "ws://localhost:8765"}</span>
      {wsError && <span className="opacity-60">({wsError})</span>}
    </div>
  );
}

function FreezeOverlay() {
  const frozen = useStore((s) => s.phic.emergency_freeze);
  if (!frozen) return null;
  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div className="absolute inset-0 border-4 border-red-600/60 rounded-none animate-pulse-slow" />
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-900/90 border border-red-600 rounded-full px-4 py-1.5 text-xs font-bold text-red-200 tracking-widest uppercase">
        ⚠ Emergency Freeze Active
      </div>
    </div>
  );
}

export default function EchoforgeDashboard() {
  // Connect to bridge WebSockets
  useEchoForge();

  const setPHIC = useStore((s) => s.setPHIC);

  // Fetch current PHIC config on mount
  useEffect(() => {
    fetchPHIC()
      .then((cfg) => cfg && setPHIC(cfg))
      .catch(() => { /* bridge may not be running yet */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2.5">
          <Hexagon size={18} className="text-emerald-400" strokeWidth={1.5} />
          <span className="font-semibold text-sm tracking-tight">EchoForge Syndicate</span>
          <span className="text-xs text-gray-600 font-mono ml-1">PHIC Dashboard</span>
        </div>
        <LiveIndicator />
      </header>

      <ConnectionBanner />
      <FreezeOverlay />

      {/* ── Main layout ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* 4-panel grid */}
        <main className="flex-1 grid grid-cols-2 grid-rows-2 gap-px bg-[var(--border)] overflow-hidden">
          <Panel title="">
            <SyndicateHealth />
          </Panel>
          <Panel title="">
            <ActiveEchoes />
          </Panel>
          <Panel title="">
            <SentinelAlerts />
          </Panel>
          <Panel title="">
            <ExecutionLog />
          </Panel>
        </main>

        {/* PHIC sidebar */}
        <aside className="w-72 border-l border-[var(--border)] bg-[var(--surface)] p-4 overflow-y-auto scroll-thin">
          <PHICControls />
        </aside>
      </div>
    </div>
  );
}

function Panel({ children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--surface)] p-4 overflow-hidden flex flex-col min-h-0">
      {children}
    </section>
  );
}

function LiveIndicator() {
  const connected = useStore((s) => s.connected);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400 sovereign-ring" : "bg-red-500"}`} />
      <span className={connected ? "text-emerald-400" : "text-red-400"}>
        {connected ? "LIVE" : "OFFLINE"}
      </span>
    </div>
  );
}
