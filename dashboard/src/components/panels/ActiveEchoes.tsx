"use client";

import { useStore, EchoEntry } from "@/lib/store";
import { BarChart2 } from "lucide-react";

const REGIME_COLORS: Record<string, string> = {
  LowVol:  "text-emerald-400 bg-emerald-950/40 border-emerald-800",
  HighVol: "text-amber-400 bg-amber-950/40 border-amber-800",
  Crisis:  "text-red-400 bg-red-950/40 border-red-800",
  Any:     "text-blue-400 bg-blue-950/40 border-blue-800",
};

function AliveBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.7 ? "bg-emerald-500" : value >= 0.4 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-gray-800 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono w-8 text-right text-gray-300">{pct}%</span>
    </div>
  );
}

const STATE_STYLES: Record<string, { dot: string; label: string }> = {
  active:      { dot: "bg-emerald-500", label: "" },
  hibernating: { dot: "bg-amber-500",   label: "HIBER" },
  dead:        { dot: "bg-red-700",     label: "DEAD" },
};

function EchoRow({ echo }: { echo: EchoEntry }) {
  const regimeClass = REGIME_COLORS[echo.regime_tag] ?? "text-gray-400 bg-gray-800/40 border-gray-700";
  const age    = Math.floor((Date.now() - echo.last_updated) / 1000);
  const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`;
  const st     = STATE_STYLES[echo.state ?? "active"] ?? STATE_STYLES.active;

  return (
    <div className="grid grid-cols-[1fr_80px_60px_40px] gap-2 items-center py-1.5 border-b border-gray-800/50">
      <div>
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} title={echo.state} />
          <p className="text-xs font-mono text-gray-200 truncate">{echo.pattern_id}</p>
          {echo.contested && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-purple-950/60 border border-purple-800 text-purple-400 font-bold shrink-0">
              CONTESTED
            </span>
          )}
          {echo.strain_count > 0 && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-950/60 border border-amber-800 text-amber-400 font-bold shrink-0"
              title={`${echo.strain_count} metabolic strain report(s)`}>
              ⚡{echo.strain_count}
            </span>
          )}
        </div>
        <AliveBar value={echo.net_aliveness} />
        {/* Beta-Bernoulli posterior */}
        {echo.success_prob != null && (
          (echo.beta_n ?? 0) < 10 ? (
            <p className="text-[9px] text-gray-700 mt-0.5 font-mono">
              P(win) — {echo.beta_n ?? 10} obs (prior)
            </p>
          ) : (
            <p className="text-[9px] font-mono mt-0.5">
              <span className="text-violet-400">P(win) {(echo.success_prob * 100).toFixed(1)}%</span>
              <span className="text-gray-600"> ±{((echo.ci95_width ?? 0) * 100).toFixed(1)}%</span>
              <span className="text-gray-700"> n={echo.beta_n}</span>
            </p>
          )
        )}
        {echo.state === "hibernating" && echo.shadow_aliveness > 0 && (
          <p className="text-[9px] text-gray-600 mt-0.5">
            shadow {Math.round(echo.shadow_aliveness * 100)}% · paper depth {echo.paper_depth}
          </p>
        )}
        {echo.peer_avg !== null && echo.peer_count > 0 && (
          <p className="text-[9px] text-gray-600 mt-0.5">
            peers: {Math.round(echo.peer_avg * 100)}% avg ({echo.peer_count})
          </p>
        )}
      </div>
      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium text-center ${regimeClass}`}>
        {echo.regime_tag}
      </span>
      <span className="text-xs text-gray-500 font-mono text-right">{echo.execution_count}×</span>
      <span className="text-[10px] text-gray-600 text-right">{ageStr}</span>
    </div>
  );
}

export function ActiveEchoes() {
  const echoes = useStore((s) => s.echoes);

  const alive = echoes
    .filter((e) => (e.state ?? "active") !== "dead")
    .sort((a, b) => b.net_aliveness - a.net_aliveness);
  const dead = echoes
    .filter((e) => (e.state ?? "active") === "dead")
    .sort((a, b) => b.net_aliveness - a.net_aliveness);

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">
          Active Echoes
        </h2>
        <div className="flex gap-3 text-xs text-gray-500">
          <span><span className="text-emerald-400 font-medium">{alive.length}</span> alive</span>
          <span><span className="text-gray-600 font-medium">{dead.length}</span> dead</span>
        </div>
      </div>

      {echoes.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
          <BarChart2 size={32} className="mb-2 opacity-30" />
          <p className="text-sm">No pattern echoes yet</p>
          <p className="text-xs mt-1">Signals flow in from the tick stream</p>
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_80px_60px_40px] gap-2 text-[10px] uppercase text-gray-600 tracking-wider pb-1 border-b border-gray-800">
            <span>Pattern / Aliveness</span>
            <span className="text-center">Regime</span>
            <span className="text-right">Execs</span>
            <span className="text-right">Age</span>
          </div>

          <div className="flex-1 overflow-y-auto scroll-thin space-y-0">
            {alive.map((e) => <EchoRow key={`${e.pattern_id}:${e.regime_tag}`} echo={e} />)}
            {dead.length > 0 && (
              <>
                <p className="text-[10px] text-gray-600 uppercase tracking-wider pt-2 pb-1">Dead</p>
                {dead.map((e) => (
                  <div key={`${e.pattern_id}:${e.regime_tag}`} className="opacity-40">
                    <EchoRow echo={e} />
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
