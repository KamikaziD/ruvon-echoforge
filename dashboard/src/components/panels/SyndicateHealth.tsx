"use client";

import { useStore } from "@/lib/store";
import { Activity, Wifi, WifiOff, Star } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

export function SyndicateHealth() {
  const metrics     = useStore((s) => s.metrics);
  const vpinHistory = useStore((s) => s.vpinHistory);
  const scoreTable  = useStore((s) => s.scoreTable);
  const connected   = useStore((s) => s.connected);

  const vpinPct = Math.round(metrics.vpin * 100);
  const vpinColor = metrics.toxic ? "text-red-400" : metrics.vpin > 0.5 ? "text-amber-400" : "text-emerald-400";

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">
          Syndicate Health
        </h2>
        <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-emerald-400" : "text-red-400"}`}>
          {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
          {connected ? `${metrics.peers} peer${metrics.peers !== 1 ? "s" : ""}` : "offline"}
        </span>
      </div>

      {/* Sovereign card */}
      <div className={`rounded-lg border p-3 ${metrics.is_sovereign ? "border-emerald-500/40 bg-emerald-950/20" : "border-gray-700 bg-gray-900/40"}`}>
        <div className="flex items-center gap-2 mb-1">
          <Star size={12} className={metrics.is_sovereign ? "text-emerald-400" : "text-gray-500"} fill={metrics.is_sovereign ? "currentColor" : "none"} />
          <span className="text-xs text-gray-400 uppercase tracking-wider">Execution Sovereign</span>
        </div>
        <p className="font-mono text-sm truncate text-gray-200">
          {metrics.sovereign_node_id}
        </p>
        <div className="mt-2 flex gap-4 text-xs text-gray-400">
          <span>S(Ex) <span className="text-emerald-400 font-medium">{metrics.s_ex.toFixed(3)}</span></span>
          <span>Latency <span className="text-gray-200 font-medium">{metrics.exchange_latency_ms}ms</span></span>
          {metrics.is_rate_limited && (
            <span className="text-red-400 font-medium">RATE LIMITED</span>
          )}
        </div>
      </div>

      {/* VPIN gauge */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="text-gray-400">VPIN</span>
          <span className={`font-mono font-bold ${vpinColor}`}>
            {vpinPct}%
            {metrics.toxic && <span className="ml-2 text-red-400 animate-pulse">TOXIC</span>}
          </span>
        </div>
        <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              metrics.toxic ? "bg-red-500" : metrics.vpin > 0.5 ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${vpinPct}%` }}
          />
        </div>
      </div>

      {/* VPIN sparkline */}
      <div className="h-32 flex-none">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={vpinHistory} margin={{ top: 2, right: 4, left: -20, bottom: 2 }}>
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, 1]} tick={{ fontSize: 10, fill: "#6b7280" }} />
            <Tooltip
              contentStyle={{ background: "#111318", border: "1px solid #1e2229", fontSize: 11 }}
              formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, "VPIN"]}
              labelFormatter={() => ""}
            />
            <ReferenceLine y={0.7} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.6} />
            <Line
              type="monotone"
              dataKey="v"
              dot={false}
              strokeWidth={1.5}
              stroke={metrics.toxic ? "#ef4444" : "#10b981"}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Peer / node table — always shown, local node pinned at top */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Mesh Nodes</p>
          <p className="text-[10px] text-gray-600">{scoreTable.length} peer{scoreTable.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="space-y-1 max-h-28 overflow-y-auto scroll-thin">
          {/* Local node always shown first */}
          <div className="flex items-center justify-between text-xs bg-gray-900/40 rounded px-1.5 py-1">
            <span className="font-mono truncate max-w-[140px] text-emerald-400 flex items-center gap-1">
              <Star size={9} fill="currentColor" />
              {metrics.sovereign_node_id !== "—"
                ? metrics.sovereign_node_id.slice(0, 14)
                : "local-node"}
              <span className="text-[9px] text-gray-600 ml-0.5">YOU</span>
            </span>
            <span className="font-mono text-emerald-400">{metrics.s_ex.toFixed(3)}</span>
          </div>
          {scoreTable
            .filter((p) => p.node_id !== metrics.sovereign_node_id)
            .sort((a, b) => b.s_ex - a.s_ex)
            .map((p) => (
              <div key={p.node_id} className="flex items-center justify-between text-xs">
                <span className={`font-mono truncate max-w-[140px] ${p.isSovereign ? "text-amber-400" : "text-gray-400"}`}>
                  {p.isSovereign && <Star size={9} className="inline mr-1 mb-0.5" fill="currentColor" />}
                  {p.node_id.slice(0, 14)}
                </span>
                <span className="font-mono text-gray-400">{p.s_ex.toFixed(3)}</span>
              </div>
            ))}
          {scoreTable.length === 0 && (
            <p className="text-[10px] text-gray-600 px-1.5 py-0.5">No peers yet — solo mode</p>
          )}
        </div>
      </div>

      {/* Passive mode warning */}
      {metrics.is_passive && (
        <div className="rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-400 flex items-center gap-2">
          <Activity size={12} />
          Passive mode — high latency detected
        </div>
      )}
    </div>
  );
}
