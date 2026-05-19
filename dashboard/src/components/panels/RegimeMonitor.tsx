"use client";

import { useMemo } from "react";
import { useStore } from "@/lib/store";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { AlertTriangle, TrendingDown } from "lucide-react";

const REGIME_COLORS: Record<string, string> = {
  LowVol:  "#34d399",
  HighVol: "#fbbf24",
  Crisis:  "#f87171",
};

// ── Regime Timeline strip ─────────────────────────────────────────────────────

function RegimeTimeline() {
  const history = useStore((s) => s.regimeHistory);
  if (history.length === 0) {
    return <div className="h-5 rounded bg-gray-800/40 flex items-center px-2 text-[9px] text-gray-600">No regime events</div>;
  }

  const windowMs = 30 * 60_000;
  const now      = Date.now();
  const cutoff   = now - windowMs;
  const recent   = history.filter((r) => r.t >= cutoff);
  const display  = recent.length ? recent : history.slice(-20);

  const segments: { regime: string; dur: number }[] = [];
  for (let i = 0; i < display.length; i++) {
    const end = i + 1 < display.length ? display[i + 1].t : now;
    segments.push({ regime: display[i].regime, dur: end - display[i].t });
  }
  const total = segments.reduce((s, r) => s + r.dur, 0) || 1;

  return (
    <div className="flex h-5 rounded overflow-hidden gap-px" title="Regime history (last 30min)">
      {segments.map((seg, i) => (
        <div
          key={i}
          style={{
            flex: (seg.dur / total) * 100,
            background: REGIME_COLORS[seg.regime] ?? "#6b7280",
            minWidth: 2,
            opacity: 0.85,
          }}
          title={seg.regime}
        />
      ))}
    </div>
  );
}

// ── Drift Alert cards ─────────────────────────────────────────────────────────

function DriftAlertCard({ alert }: { alert: { id: string; pattern_id: string; slope: number; r2: number; time_to_zero_min: number; timestamp: number } }) {
  const urgency = alert.time_to_zero_min < 30 ? "danger" : "warn";
  const colorClass = urgency === "danger"
    ? "border-red-800 bg-red-950/30 text-red-400"
    : "border-amber-800 bg-amber-950/30 text-amber-400";

  return (
    <div className={`rounded border px-3 py-2 flex items-start gap-2 ${colorClass}`}>
      <TrendingDown size={12} className="shrink-0 mt-0.5" />
      <div className="text-[10px] font-mono">
        <p className="font-bold">{alert.pattern_id}</p>
        <p className="opacity-70">
          slope {alert.slope.toFixed(5)} · R² {alert.r2.toFixed(2)} · zero in ~{alert.time_to_zero_min.toFixed(0)}min
        </p>
      </div>
    </div>
  );
}

// ── Per-pattern rolling net_alpha chart ───────────────────────────────────────

function PatternRollingChart() {
  const outcomes = useStore((s) => s.outcomes);

  // Group outcomes by pattern, compute rolling median over last 20 per pattern
  const series = useMemo(() => {
    const byPattern: Record<string, { t: number; score: number }[]> = {};
    for (const o of outcomes) {
      if (!byPattern[o.pattern_id]) byPattern[o.pattern_id] = [];
      byPattern[o.pattern_id].push({ t: o.timestamp, score: o.outcome_score });
    }

    // Build unified timeline — take last 50 outcomes globally, compute rolling median per pattern
    const allTs = Array.from(new Set(outcomes.map((o) => o.timestamp))).sort().slice(-50);
    if (allTs.length < 2) return null;

    const patternIds = Object.keys(byPattern).slice(0, 6); // max 6 lines
    const chartData = allTs.map((t) => {
      const point: Record<string, number | string> = { t };
      for (const pid of patternIds) {
        const relevant = (byPattern[pid] ?? []).filter((o) => o.t <= t).slice(-10);
        if (relevant.length > 0) {
          const sorted = relevant.map((o) => o.score).sort((a, b) => a - b);
          point[pid] = sorted[Math.floor(sorted.length / 2)];
        }
      }
      return point;
    });

    return { chartData, patternIds };
  }, [outcomes]);

  if (!series) {
    return <Empty>No outcome data yet — trades flow in after signals pass</Empty>;
  }

  const PATTERN_COLORS = ["#34d399", "#60a5fa", "#f59e0b", "#a78bfa", "#f87171", "#22d3ee"];

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={series.chartData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
        <XAxis dataKey="t" hide />
        <YAxis tickFormatter={(v: number) => v.toFixed(2)} tick={{ fontSize: 8, fill: "#6b7280" }} />
        <ReferenceLine y={0} stroke="#374151" strokeDasharray="3 3" />
        <Tooltip
          contentStyle={{ background: "#111318", border: "1px solid #1e2229", fontSize: 10, fontFamily: "monospace" }}
          formatter={(v: number, name: string) => [v.toFixed(4), name]}
          labelFormatter={() => ""}
        />
        {series.patternIds.map((pid, i) => (
          <Line
            key={pid}
            type="monotone"
            dataKey={pid}
            stroke={PATTERN_COLORS[i % PATTERN_COLORS.length]}
            dot={false}
            strokeWidth={1.5}
            connectNulls
            name={pid}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Regime duration breakdown ─────────────────────────────────────────────────

function RegimeDurationTable() {
  const history = useStore((s) => s.regimeHistory);
  const now = Date.now();

  const durations: Record<string, number> = {};
  for (let i = 0; i < history.length; i++) {
    const end = i + 1 < history.length ? history[i + 1].t : now;
    const dur = end - history[i].t;
    durations[history[i].regime] = (durations[history[i].regime] ?? 0) + dur;
  }

  const total = Object.values(durations).reduce((s, v) => s + v, 0) || 1;
  const entries = Object.entries(durations).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-1">
      {entries.map(([regime, dur]) => {
        const pct = Math.round((dur / total) * 100);
        const color = REGIME_COLORS[regime] ?? "#6b7280";
        return (
          <div key={regime} className="flex items-center gap-2 text-[10px]">
            <span className="w-16 font-mono" style={{ color }}>{regime}</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-800">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
            <span className="w-8 text-right text-gray-500">{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-gray-600 text-center mt-8">{children}</p>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function RegimeMonitor() {
  const driftAlerts   = useStore((s) => s.driftAlerts);
  const currentRegime = useStore((s) => s.currentRegime);
  const regimeColor   = REGIME_COLORS[currentRegime] ?? "#94a3b8";

  return (
    <div className="flex flex-col h-full gap-4 overflow-y-auto scroll-thin">
      {/* Current regime */}
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">Regime Monitor</h2>
        <span className="text-xs font-mono font-bold" style={{ color: regimeColor }}>{currentRegime}</span>
      </div>

      {/* Timeline strip */}
      <div className="shrink-0">
        <p className="text-[9px] uppercase tracking-widest text-gray-600 mb-1">Timeline (last 30min)</p>
        <RegimeTimeline />
      </div>

      {/* Drift alerts */}
      {driftAlerts.length > 0 && (
        <div className="shrink-0">
          <div className="flex items-center gap-1.5 mb-2">
            <AlertTriangle size={10} className="text-amber-400" />
            <p className="text-[9px] uppercase tracking-widest text-amber-400">Drift Alerts</p>
          </div>
          <div className="space-y-1.5">
            {driftAlerts.slice(0, 5).map((a) => <DriftAlertCard key={a.id} alert={a} />)}
          </div>
        </div>
      )}

      {/* Per-pattern rolling net_alpha */}
      <div className="shrink-0">
        <p className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Rolling Net Alpha (median per pattern)</p>
        <div className="h-40">
          <PatternRollingChart />
        </div>
      </div>

      {/* Regime duration breakdown */}
      <div className="shrink-0">
        <p className="text-[9px] uppercase tracking-widest text-gray-600 mb-2">Session Regime Distribution</p>
        <RegimeDurationTable />
      </div>
    </div>
  );
}
