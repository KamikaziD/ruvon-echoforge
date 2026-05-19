"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useEchoForge } from "@/hooks/useEchoForge";
import { useStore } from "@/lib/store";
import { TradingDeck }    from "@/components/panels/TradingDeck";
import { PHICControls }   from "@/components/PHICControls";
import { fetchPHIC }      from "@/lib/api";
import {
  Hexagon, WifiOff, Ghost,
  LayoutDashboard, FlaskConical, Activity, Settings2, Search,
  ChevronLeft, ChevronRight,
} from "lucide-react";

// Heavy panels loaded client-side only to avoid SSR issues with Recharts/FileReader
const PatternLab      = dynamic(() => import("@/components/panels/PatternLab").then((m) => ({ default: m.PatternLab })), { ssr: false });
const RegimeMonitor   = dynamic(() => import("@/components/panels/RegimeMonitor").then((m) => ({ default: m.RegimeMonitor })), { ssr: false });
const MacroStatePanel = dynamic(() => import("@/components/panels/MacroStatePanel").then((m) => ({ default: m.MacroStatePanel })), { ssr: false });
const Forensics       = dynamic(() => import("@/components/panels/Forensics").then((m) => ({ default: m.Forensics })), { ssr: false });

// ── Type definitions ──────────────────────────────────────────────────────────

type SectionId = "overview" | "patterns" | "regime" | "governance" | "forensics";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "overview",    label: "Overview",        icon: <LayoutDashboard size={16} /> },
  { id: "patterns",   label: "Pattern Lab",      icon: <FlaskConical    size={16} /> },
  { id: "regime",     label: "Regime Monitor",   icon: <Activity        size={16} /> },
  { id: "governance", label: "Governance",       icon: <Settings2       size={16} /> },
  { id: "forensics",  label: "Forensics",        icon: <Search          size={16} /> },
];

// ── Shared UI helpers ─────────────────────────────────────────────────────────

function ConnectionBanner() {
  const { connected, wsError } = useStore((s) => ({ connected: s.connected, wsError: s.wsError }));
  if (connected) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-red-950/40 border-b border-red-900/40 text-xs text-red-400 shrink-0">
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
      <div className="absolute inset-0 border-4 border-red-600/60 animate-pulse" />
      <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-900/90 border border-red-600 rounded-full px-4 py-1.5 text-xs font-bold text-red-200 tracking-widest uppercase">
        ⚠ Emergency Freeze Active
      </div>
    </div>
  );
}

function DaemonGhostBanner() {
  const waiting = useStore((s) => s.daemonWaitingForStart);
  if (!waiting) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-950/40 border-b border-amber-700/40 text-xs text-amber-300 shrink-0">
      <Ghost size={11} />
      <span className="font-semibold">Daemon in Ghost Mode</span>
      <span className="opacity-70">— observing market, execution disabled. Apply a preset or enable trading in Governance to start live execution.</span>
    </div>
  );
}

function LiveIndicator() {
  const connected = useStore((s) => s.connected);
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400 sovereign-ring" : "bg-red-500"}`} />
      <span className={connected ? "text-emerald-400" : "text-red-400"}>
        {connected ? "LIVE" : "OFFLINE"}
      </span>
    </div>
  );
}

// ── Vertical nav sidebar ──────────────────────────────────────────────────────

function NavSidebar({
  active, onChange,
}: {
  active: SectionId; onChange: (s: SectionId) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const connected  = useStore((s) => s.connected);
  const vpin       = useStore((s) => s.metrics.vpin);
  const regime     = useStore((s) => s.currentRegime);
  const driftCount = useStore((s) => s.driftAlerts.length);

  const regimeColor = { LowVol: "#34d399", HighVol: "#fbbf24", Crisis: "#f87171" }[regime] ?? "#94a3b8";

  return (
    <aside
      className="flex flex-col border-r border-[var(--border)] bg-[var(--surface)] shrink-0 transition-all duration-200"
      style={{ width: expanded ? 200 : 52 }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-[var(--border)]">
        <Hexagon size={18} className="text-emerald-400 shrink-0" strokeWidth={1.5} />
        {expanded && <span className="font-semibold text-sm tracking-tight truncate">EchoForge</span>}
      </div>

      {/* Nav items */}
      <nav className="flex flex-col gap-0.5 p-2 flex-1">
        {SECTIONS.map(({ id, label, icon }) => {
          const isActive = active === id;
          const hasBadge = id === "regime" && driftCount > 0;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              title={!expanded ? label : undefined}
              className={`flex items-center gap-2.5 px-2 py-2 rounded-lg text-xs font-medium transition-colors relative ${
                isActive
                  ? "bg-gray-700/60 text-gray-100"
                  : "text-gray-500 hover:text-gray-300 hover:bg-gray-800/40"
              }`}
            >
              <span className="shrink-0">{icon}</span>
              {expanded && <span className="truncate">{label}</span>}
              {hasBadge && (
                <span className="ml-auto shrink-0 h-4 w-4 rounded-full bg-amber-500 text-[9px] text-black font-bold flex items-center justify-center">
                  {driftCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Mini status */}
      <div className="p-2 border-t border-[var(--border)] space-y-1.5">
        {expanded ? (
          <>
            <div className="flex items-center justify-between text-[9px] font-mono">
              <span className="text-gray-600">VPIN</span>
              <span className={vpin > 0.7 ? "text-red-400" : vpin > 0.45 ? "text-amber-400" : "text-emerald-400"}>
                {vpin.toFixed(3)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px] font-mono">
              <span className="text-gray-600">Regime</span>
              <span style={{ color: regimeColor }}>{regime}</span>
            </div>
            <div className="flex items-center justify-between text-[9px]">
              <span className="text-gray-600">Bridge</span>
              <LiveIndicator />
            </div>
          </>
        ) : (
          <div className="flex justify-center">
            <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-500"}`} />
          </div>
        )}

        {/* Collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center py-1 text-gray-600 hover:text-gray-400 transition-colors rounded hover:bg-gray-800/40"
        >
          {expanded ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
    </aside>
  );
}

// ── Content panel wrapper ─────────────────────────────────────────────────────

function ContentPane({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex-1 overflow-hidden flex flex-col min-h-0 min-w-0">
      <div className="flex-1 overflow-auto scroll-thin p-4 min-h-0">
        {children}
      </div>
    </section>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function EchoforgeDashboard() {
  useEchoForge();

  const setPHIC = useStore((s) => s.setPHIC);
  const [section, setSection] = useState<SectionId>("overview");

  useEffect(() => {
    fetchPHIC()
      .then((cfg) => cfg && setPHIC(cfg))
      .catch(() => { /* bridge may not be running yet */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-screen flex flex-col bg-[var(--bg)] text-[var(--text)] overflow-hidden">
      {/* ── Header ── */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-600 font-mono">PHIC Dashboard</span>
        </div>
        <div className="flex items-center gap-3">
          <SectionBreadcrumb active={section} />
          <LiveIndicator />
        </div>
      </header>

      <ConnectionBanner />
      <DaemonGhostBanner />
      <FreezeOverlay />

      {/* ── Body: nav + content ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        <NavSidebar active={section} onChange={setSection} />

        {/* Main content — full-bleed for Trading Deck, padded for others */}
        {section === "overview" ? (
          <div className="flex-1 overflow-hidden min-h-0">
            <TradingDeck />
          </div>
        ) : section === "governance" ? (
          <ContentPane>
            <PHICControls />
          </ContentPane>
        ) : (
          <ContentPane>
            {section === "patterns" && <PatternLab />}
            {section === "regime"   && (
              <div className="space-y-6">
                <div>
                  <p className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Macro Governor</p>
                  <MacroStatePanel />
                </div>
                <RegimeMonitor />
              </div>
            )}
            {section === "forensics" && <Forensics />}
          </ContentPane>
        )}
      </div>
    </div>
  );
}

function SectionBreadcrumb({ active }: { active: SectionId }) {
  const label = SECTIONS.find((s) => s.id === active)?.label ?? "";
  return <span className="text-xs text-gray-400 font-medium">{label}</span>;
}
