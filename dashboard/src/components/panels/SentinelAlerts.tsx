"use client";

import { useStore, SentinelAlert } from "@/lib/store";
import { ShieldAlert, ShieldCheck, AlertTriangle, Zap, Activity } from "lucide-react";

const SENTINEL_META: Record<string, { icon: typeof Zap; color: string; label: string }> = {
  Nociceptor:    { icon: Zap,           color: "text-red-400 border-red-900 bg-red-950/20",           label: "VPIN" },
  Proprioceptor: { icon: Activity,      color: "text-amber-400 border-amber-900 bg-amber-950/20",     label: "LATENCY" },
  Metabolic:     { icon: AlertTriangle, color: "text-blue-400 border-blue-900 bg-blue-950/20",        label: "METABOLIC" },
  Contested:     { icon: ShieldAlert,   color: "text-purple-400 border-purple-900 bg-purple-950/20", label: "CONTESTED" },
  Regime:        { icon: Activity,      color: "text-cyan-400 border-cyan-900 bg-cyan-950/20",        label: "REGIME" },
};

function AlertRow({ alert }: { alert: SentinelAlert }) {
  const meta = SENTINEL_META[alert.sentinel_type] ?? {
    icon: ShieldAlert,
    color: "text-gray-400 border-gray-700 bg-gray-800/20",
    label: alert.sentinel_type,
  };
  const Icon  = meta.icon;
  const ts    = new Date(alert.timestamp).toLocaleTimeString("en-ZA", { hour12: false });
  const sev   = Math.round(alert.severity * 100);

  return (
    <div className={`flex gap-2 p-2 rounded border text-xs ${meta.color}`}>
      <Icon size={12} className="mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-semibold tracking-wide">{alert.action}</span>
          <span className="text-[10px] font-mono opacity-60">{ts}</span>
        </div>
        {alert.detail && (
          <p className="opacity-70 mt-0.5 truncate font-mono">{alert.detail}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[10px] opacity-50 uppercase tracking-wider">{meta.label}</div>
        <div className="font-mono font-bold">{sev}%</div>
      </div>
    </div>
  );
}

export function SentinelAlerts() {
  const alerts = useStore((s) => s.alerts);

  // Aggregate counts by type for the summary bar
  const counts = alerts.reduce((acc, a) => {
    acc[a.sentinel_type] = (acc[a.sentinel_type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">
          Sentinel Alerts
        </h2>
        {alerts.length === 0 ? (
          <span className="flex items-center gap-1 text-xs text-emerald-400">
            <ShieldCheck size={12} /> all clear
          </span>
        ) : (
          <span className="text-xs text-gray-500">{alerts.length} total</span>
        )}
      </div>

      {/* Type summary pills */}
      {alerts.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {Object.entries(counts).map(([type, n]) => {
            const meta = SENTINEL_META[type];
            if (!meta) return null;
            return (
              <span key={type} className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${meta.color}`}>
                {meta.label} ×{n}
              </span>
            );
          })}
        </div>
      )}

      {alerts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
          <ShieldCheck size={32} className="mb-2 opacity-30" />
          <p className="text-sm">No sentinel alerts</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scroll-thin space-y-1.5">
          {alerts.map((a) => <AlertRow key={a.id} alert={a} />)}
        </div>
      )}
    </div>
  );
}
