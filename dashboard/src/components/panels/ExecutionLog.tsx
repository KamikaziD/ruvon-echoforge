"use client";

import { useState } from "react";
import { useStore, ExecutionEvent, Portfolio, NodeMetrics, Position } from "@/lib/store";
import {
  CheckCircle2, XCircle, Database, ArrowRightLeft,
  TrendingUp, TrendingDown, Wallet, BarChart2,
} from "lucide-react";

const ExecutionEventENT_META: Record<ExecutionEvent["type"], { icon: typeof CheckCircle2; color: string; label: string }> = {
  submitted:  { icon: CheckCircle2,    color: "text-emerald-400", label: "FILLED" },
  failed:     { icon: XCircle,         color: "text-red-400",     label: "FAILED" },
  saf_queued: { icon: Database,        color: "text-amber-400",   label: "SAF" },
  routed:     { icon: ArrowRightLeft,  color: "text-blue-400",    label: "ROUTED" },
};

function EventRow({ ev }: { ev: ExecutionEvent }) {
  const meta = ExecutionEventENT_META[ev.type];
  const Icon = meta.icon;
  const ts   = new Date(ev.timestamp).toLocaleTimeString("en-ZA", { hour12: false });
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-gray-800/50 text-xs">
      <Icon size={11} className={`mt-0.5 shrink-0 ${meta.color}`} />
      <div className="flex-1 min-w-0">
        <span className={`font-semibold ${meta.color}`}>{meta.label}</span>
        <span className="text-gray-400 ml-1.5 font-mono truncate">{ev.pattern_id}</span>
        {ev.detail && <p className="text-gray-500 font-mono truncate mt-0.5">{ev.detail}</p>}
      </div>
      <span className="text-[10px] text-gray-600 font-mono shrink-0">{ts}</span>
    </div>
  );
}

function PnlVal({ v }: { v: number }) {
  const color = v >= 0 ? "text-emerald-400" : "text-red-400";
  return <span className={`font-mono ${color}`}>{v >= 0 ? "+" : ""}${v.toFixed(2)}</span>;
}

function PositionRow({ pair, pos }: { pair: string; pos: Position }) {
  const winPct = pos.trade_count > 0 ? Math.round((pos.wins / pos.trade_count) * 100) : 0;
  return (
    <div className="border-b border-gray-800/50 py-2 text-[10px]">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-gray-200 font-mono">{pair}</span>
        <span className="text-gray-500">{pos.trade_count} trade{pos.trade_count !== 1 ? "s" : ""} · {winPct}% win</span>
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 text-gray-400">
        {pos.coin > 0 && (
          <>
            <span className="text-gray-500">Held</span>
            <span className="font-mono text-gray-200 col-span-3">{pos.coin.toFixed(6)} ({pair.split("/")[0]})</span>
            <span className="text-gray-500">Avg Cost</span>
            <span className="font-mono text-gray-200 col-span-3">${pos.avg_cost.toLocaleString()}</span>
            <span className="text-gray-500">Unreal PnL</span>
            <span className="col-span-3"><PnlVal v={pos.unrealized_pnl} /></span>
          </>
        )}
        <span className="text-gray-500">Realised</span>
        <span className="col-span-3"><PnlVal v={pos.realized_pnl} /></span>
        {pos.value > 0 && (
          <>
            <span className="text-gray-500">Value</span>
            <span className="font-mono text-gray-200 col-span-3">${pos.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </>
        )}
      </div>
    </div>
  );
}

function WalletTab({ portfolio }: { portfolio: Portfolio }) {
  const pnl      = portfolio.total_pnl;
  const pnlColor = pnl >= 0 ? "text-emerald-400" : "text-red-400";
  const PnlIcon  = pnl >= 0 ? TrendingUp : TrendingDown;

  const positions = portfolio.positions ?? {};
  const pairs     = Object.keys(positions);

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      {/* Portfolio summary card */}
      <div className={`rounded-lg border p-3 ${pnl >= 0 ? "border-emerald-800/50 bg-emerald-950/20" : "border-red-800/50 bg-red-950/20"}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
            <PnlIcon size={11} className={pnlColor} />
            Total Portfolio
          </span>
          <span className={`text-base font-bold font-mono ${pnlColor}`}>
            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-2 text-[10px]">
          <div>
            <p className="text-gray-500 uppercase">USDT</p>
            <p className="font-mono text-gray-200">${portfolio.usdt.toFixed(0)}</p>
          </div>
          <div>
            <p className="text-gray-500 uppercase">BTC</p>
            <p className="font-mono text-gray-200">{portfolio.btc.toFixed(5)}</p>
          </div>
          <div>
            <p className="text-gray-500 uppercase">Realised</p>
            <p className={`font-mono ${portfolio.realized_pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {portfolio.realized_pnl >= 0 ? "+" : ""}${portfolio.realized_pnl.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-gray-500 uppercase">Net Value</p>
            <p className="font-mono text-gray-200">${portfolio.total_value.toFixed(0)}</p>
          </div>
        </div>
      </div>

      {/* Per-pair positions */}
      <div className="flex-1 overflow-y-auto scroll-thin">
        {pairs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-600 text-sm gap-2">
            <Wallet size={28} className="opacity-30" />
            <span>No positions yet</span>
          </div>
        ) : (
          pairs.map((pair) => (
            <PositionRow key={pair} pair={pair} pos={positions[pair]} />
          ))
        )}
      </div>
    </div>
  );
}

function TradesTab({
  execLog, metrics,
}: {
  execLog: ExecutionEvent[];
  metrics: NodeMetrics;
}) {
  const submitted = execLog.filter((e: ExecutionEvent) => e.type === "submitted").length;
  const failed    = execLog.filter((e: ExecutionEvent) => e.type === "failed").length;

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Filled"   value={submitted}  color="text-emerald-400" />
        <Stat label="Failed"   value={failed}      color="text-red-400" />
        <Stat label="Win Rate" value={`${Math.round(metrics.success_rate * 100)}%`} color="text-blue-400" />
      </div>

      {execLog.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-600">
          <TrendingUp size={32} className="mb-2 opacity-30" />
          <p className="text-sm">No executions yet</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scroll-thin">
          {execLog.map((ev: ExecutionEvent) => <EventRow key={ev.id} ev={ev} />)}
        </div>
      )}
    </div>
  );
}

export function ExecutionLog() {
  const [tab, setTab]   = useState<"wallet" | "trades">("wallet");
  const execLog         = useStore((s) => s.execLog);
  const metrics         = useStore((s) => s.metrics);
  const portfolio       = useStore((s) => s.portfolio);

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header + tabs */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">
          Execution
        </h2>
        <div className="flex items-center gap-1 bg-gray-900 rounded-lg p-0.5">
          <TabBtn active={tab === "wallet"} onClick={() => setTab("wallet")}>
            <Wallet size={10} className="mr-1" />Wallet
          </TabBtn>
          <TabBtn active={tab === "trades"} onClick={() => setTab("trades")}>
            <BarChart2 size={10} className="mr-1" />Trades
          </TabBtn>
        </div>
      </div>

      {tab === "wallet"
        ? <WalletTab portfolio={portfolio} />
        : <TradesTab execLog={execLog} metrics={metrics} />
      }

      {metrics.saf_pending > 0 && (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-400 flex items-center gap-2">
          <Database size={11} />
          {metrics.saf_pending} order{metrics.saf_pending !== 1 ? "s" : ""} queued offline
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center text-[10px] px-2 py-1 rounded-md transition-colors ${
        active
          ? "bg-gray-700 text-gray-100"
          : "text-gray-500 hover:text-gray-300"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-lg bg-gray-900/60 border border-gray-800 px-2 py-1.5 text-center">
      <p className={`text-base font-bold font-mono ${color}`}>{value}</p>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
    </div>
  );
}
