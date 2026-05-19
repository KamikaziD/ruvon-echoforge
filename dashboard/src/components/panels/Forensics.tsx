"use client";

import { useState, useMemo } from "react";
import { useStore } from "@/lib/store";
import { computeDistributions } from "@/lib/distributions";
import { Search, Download, Clock, Shield, Zap } from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${color}`}>
      {children}
    </span>
  );
}

// ── Execution Log tab ─────────────────────────────────────────────────────────

function ExecLogTab() {
  const execLog   = useStore((s) => s.execLog);
  const [search,  setSearch]  = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  const filtered = useMemo(() =>
    execLog.filter((ev) => {
      const matchSearch = !search || ev.pattern_id.includes(search.toUpperCase()) || ev.detail.toLowerCase().includes(search.toLowerCase());
      const matchType   = !typeFilter || ev.type === typeFilter;
      return matchSearch && matchType;
    }),
    [execLog, search, typeFilter]
  );

  const TYPE_COLORS: Record<string, string> = {
    submitted:  "bg-emerald-950/60 border border-emerald-800 text-emerald-400",
    failed:     "bg-red-950/60     border border-red-800     text-red-400",
    saf_queued: "bg-amber-950/60   border border-amber-800   text-amber-400",
    routed:     "bg-blue-950/60    border border-blue-800    text-blue-400",
  };

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-2 shrink-0">
        <div className="relative flex-1">
          <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter pattern or detail…"
            className="w-full pl-6 pr-2 py-1 bg-gray-900 border border-gray-700 rounded text-[10px] text-gray-300 placeholder:text-gray-600"
          />
        </div>
        <select
          value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-300"
        >
          <option value="">All types</option>
          <option value="submitted">Submitted</option>
          <option value="failed">Failed</option>
          <option value="saf_queued">SAF</option>
          <option value="routed">Routed</option>
        </select>
      </div>

      <p className="text-[9px] text-gray-600 shrink-0">{filtered.length} of {execLog.length} events</p>

      {execLog.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
          <Clock size={28} className="mb-2 opacity-30" />
          <p className="text-sm">No execution events</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scroll-thin space-y-0">
          {filtered.map((ev) => (
            <div key={ev.id} className="flex items-start gap-2 py-1.5 border-b border-gray-800/50">
              <span className="text-[9px] text-gray-600 font-mono shrink-0 w-16">{ts(ev.timestamp)}</span>
              <Badge color={TYPE_COLORS[ev.type] ?? "text-gray-400"}>{ev.type}</Badge>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-mono text-gray-300 truncate">{ev.pattern_id}</p>
                <p className="text-[9px] text-gray-500 truncate">{ev.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sentinel History tab ──────────────────────────────────────────────────────

function SentinelHistoryTab() {
  const alerts = useStore((s) => s.alerts);
  const [filter, setFilter] = useState("");

  const filtered = filter
    ? alerts.filter((a) => a.sentinel_type === filter || a.action === filter)
    : alerts;

  const TYPE_COLORS: Record<string, string> = {
    Nociceptor: "text-red-400 border-red-800 bg-red-950/40",
    Proprioceptor: "text-amber-400 border-amber-800 bg-amber-950/40",
    Metabolic:  "text-purple-400 border-purple-800 bg-purple-950/40",
  };

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-2 shrink-0 items-center">
        <Shield size={10} className="text-gray-500" />
        <select
          value={filter} onChange={(e) => setFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-300"
        >
          <option value="">All sentinels</option>
          <option value="Nociceptor">Nociceptor</option>
          <option value="Proprioceptor">Proprioceptor</option>
          <option value="Metabolic">Metabolic</option>
        </select>
        <span className="text-[9px] text-gray-600 ml-auto">{filtered.length} alerts</span>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin space-y-0">
        {filtered.map((a) => (
          <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-gray-800/50">
            <span className="text-[9px] text-gray-600 font-mono shrink-0 w-16">{ts(a.timestamp)}</span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold shrink-0 ${TYPE_COLORS[a.sentinel_type] ?? "text-gray-400 border-gray-700"}`}>
              {a.sentinel_type.slice(0, 4).toUpperCase()}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-mono text-gray-300 truncate">{a.action}</p>
              <p className="text-[9px] text-gray-500 truncate">{a.detail}</p>
            </div>
            <span className="text-[9px] text-gray-600 shrink-0">{(a.severity * 100).toFixed(0)}%</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-gray-600 text-center mt-8">No sentinel alerts</p>
        )}
      </div>
    </div>
  );
}

// ── Session Export tab ────────────────────────────────────────────────────────

function SessionExportTab() {
  const outcomes      = useStore((s) => s.outcomes);
  const execLog       = useStore((s) => s.execLog);
  const alerts        = useStore((s) => s.alerts);
  const metrics       = useStore((s) => s.metrics);
  const portfolio     = useStore((s) => s.portfolio);
  const distributions = useMemo(() => computeDistributions(outcomes), [outcomes]);

  const exportSession = () => {
    const data = {
      exported_at:   Date.now(),
      metrics,
      portfolio,
      outcomes,
      distributions,
      execLog:       execLog.slice(0, 500),
      alerts:        alerts.slice(0, 200),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `echoforge-dashboard-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 text-[10px]">
        {[
          ["Outcomes", outcomes.length],
          ["Distributions", Object.keys(distributions).length],
          ["Exec Events", execLog.length],
          ["Alerts", alerts.length],
        ].map(([label, count]) => (
          <div key={label as string} className="bg-gray-900/60 rounded border border-gray-800 px-3 py-2">
            <p className="text-gray-600 text-[9px] uppercase tracking-wider mb-0.5">{label}</p>
            <p className="text-gray-200 font-mono font-bold text-sm">{count}</p>
          </div>
        ))}
      </div>

      <button
        onClick={exportSession}
        className="flex items-center justify-center gap-2 py-2 rounded bg-emerald-900/40 border border-emerald-800 text-emerald-400 text-xs hover:bg-emerald-900/70 transition-colors"
      >
        <Download size={12} /> Export Dashboard Session JSON
      </button>

      <p className="text-[9px] text-gray-600">
        Exports current in-memory state. For full session replay (ticks + decisions), use the node browser export.
      </p>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type ForensicsTab = "exec" | "sentinel" | "export";

export function Forensics() {
  const [tab, setTab] = useState<ForensicsTab>("exec");

  const TABS: { id: ForensicsTab; label: string; icon: React.ReactNode }[] = [
    { id: "exec",     label: "Execution",  icon: <Zap size={10} /> },
    { id: "sentinel", label: "Sentinels",  icon: <Shield size={10} /> },
    { id: "export",   label: "Export",     icon: <Download size={10} /> },
  ];

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">Forensics</h2>
        <div className="flex items-center gap-1 bg-gray-900/60 rounded-lg p-0.5 border border-gray-800">
          {TABS.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                tab === id ? "bg-gray-700 text-gray-100" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {icon}{label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "exec"     && <ExecLogTab />}
        {tab === "sentinel" && <SentinelHistoryTab />}
        {tab === "export"   && <SessionExportTab />}
      </div>
    </div>
  );
}
