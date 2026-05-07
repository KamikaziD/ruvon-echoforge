"use client";

import { useStore } from "@/lib/store";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";

const REGIME_COLORS: Record<string, string> = {
  LowVol:  "#34d399",
  HighVol: "#fbbf24",
  Crisis:  "#f87171",
};

const ALL_PATTERNS = [
  "MOMENTUM_V1", "DEPTH_GRAB", "SUPERTREND_CROSS",
  "WHALE_WAKE", "ARBI_CROSS_EXCHANGE", "REVERSION_A", "SPREAD_FADE",
];
const ALL_REGIMES = ["LowVol", "HighVol", "Crisis"];

export function TradingDeck() {
  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-px bg-[var(--border)] w-full h-full overflow-hidden">
      <Panel title="Equity Curve">
        <EquityCurve />
      </Panel>
      <Panel title="L2 Order Book">
        <L2Depth />
      </Panel>
      <Panel title="Open Positions">
        <PositionsDetail />
      </Panel>
      <Panel title="Win-Rate Heatmap">
        <WinRateHeatmap />
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--surface)] p-4 flex flex-col overflow-hidden min-h-0">
      <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2 shrink-0">{title}</p>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

// ── Equity Curve ─────────────────────────────────────────────────────────────

function EquityCurve() {
  const history  = useStore((s) => s.equityHistory);
  const regimes  = useStore((s) => s.regimeHistory);

  if (history.length < 2) {
    return <Empty>Waiting for portfolio updates…</Empty>;
  }

  const start   = history[0]?.v ?? 10_000;
  const current = history[history.length - 1]?.v ?? start;
  const pnl     = current - start;
  const pnlPct  = start > 0 ? ((pnl / start) * 100).toFixed(2) : "0.00";
  const color   = pnl >= 0 ? "#34d399" : "#f87171";

  const lastRegime = regimes[regimes.length - 1]?.regime ?? "LowVol";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-baseline gap-3 mb-2 shrink-0">
        <span className="text-sm font-mono" style={{ color }}>
          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
        </span>
        <span className="text-xs text-gray-500">({pnl >= 0 ? "+" : ""}{pnlPct}%)</span>
        <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{ color: REGIME_COLORS[lastRegime] ?? "#9ca3af",
                   background: (REGIME_COLORS[lastRegime] ?? "#9ca3af") + "22" }}>
          {lastRegime}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={history} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="eq-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"   stopColor={color} stopOpacity={0.25} />
                <stop offset="95%"  stopColor={color} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" hide />
            <YAxis domain={["auto", "auto"]} tick={{ fontSize: 9, fill: "#6b7280" }} width={48} />
            <ReferenceLine y={start} stroke="#4b5563" strokeDasharray="3 3" />
            <Tooltip
              contentStyle={{ background: "#111", border: "1px solid #374151", borderRadius: 6, fontSize: 10 }}
              formatter={(v: number) => [`$${v.toFixed(2)}`, "Equity"]}
              labelFormatter={() => ""}
            />
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
              fill="url(#eq-grad)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── L2 Depth ─────────────────────────────────────────────────────────────────

function L2Depth() {
  const { bids, asks } = useStore((s) => s.l2Depth);

  if (bids.length === 0 && asks.length === 0) {
    return <Empty>Waiting for L2 depth…</Empty>;
  }

  const bidData = [...bids].reverse().map(([price, qty]) => ({
    price: price.toFixed(2), qty, side: "bid",
  }));
  const askData = asks.map(([price, qty]) => ({
    price: price.toFixed(2), qty, side: "ask",
  }));

  return (
    <div className="flex gap-1 h-full">
      {/* Bids */}
      <div className="flex-1 min-w-0">
        <p className="text-[9px] text-emerald-500 mb-1">BIDS</p>
        <ResponsiveContainer width="100%" height="90%">
          <BarChart data={bidData} layout="vertical" margin={{ left: 0, right: 4, top: 0, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="price" tick={{ fontSize: 8, fill: "#6b7280" }} width={52} />
            <Bar dataKey="qty" radius={[0, 2, 2, 0]}>
              {bidData.map((_, i) => <Cell key={i} fill="#34d399" fillOpacity={0.7} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Asks */}
      <div className="flex-1 min-w-0">
        <p className="text-[9px] text-red-400 mb-1">ASKS</p>
        <ResponsiveContainer width="100%" height="90%">
          <BarChart data={askData} layout="vertical" margin={{ left: 4, right: 0, top: 0, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="price" tick={{ fontSize: 8, fill: "#6b7280" }} width={52} />
            <Bar dataKey="qty" radius={[2, 0, 0, 2]}>
              {askData.map((_, i) => <Cell key={i} fill="#f87171" fillOpacity={0.7} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Positions Detail ──────────────────────────────────────────────────────────

function PositionsDetail() {
  const portfolio  = useStore((s) => s.portfolio);
  const stopLossPct = useStore((s) => s.phic.stop_loss_pct);

  const { btc, avg_cost, unrealized_pnl, total_value, realized_pnl } = portfolio;
  const currentPrice = avg_cost > 0 && btc > 0
    ? avg_cost + (btc > 0 ? unrealized_pnl / btc : 0)
    : 0;

  const pnlColor = unrealized_pnl >= 0 ? "text-emerald-400" : "text-red-400";
  const realColor = realized_pnl  >= 0 ? "text-emerald-400" : "text-red-400";

  const stopLossPrice = avg_cost > 0 ? avg_cost * (1 - stopLossPct / 100) : 0;
  const distToStop    = currentPrice > 0 && stopLossPrice > 0
    ? ((currentPrice - stopLossPrice) / currentPrice * 100).toFixed(2) : null;

  return (
    <div className="space-y-2 text-xs font-mono">
      <Row label="Total Value"   value={`$${total_value.toFixed(2)}`} />
      <Row label="BTC Position"  value={`${btc.toFixed(6)} BTC`} />
      <Row label="Avg Cost"      value={avg_cost > 0 ? `$${avg_cost.toFixed(2)}` : "—"} />
      <Row label="Current Price" value={currentPrice > 0 ? `$${currentPrice.toFixed(2)}` : "—"} />
      <Row label="Unrealized PnL"
        value={`${unrealized_pnl >= 0 ? "+" : ""}$${unrealized_pnl.toFixed(2)}`}
        className={pnlColor} />
      <Row label="Realized PnL"
        value={`${realized_pnl >= 0 ? "+" : ""}$${realized_pnl.toFixed(2)}`}
        className={realColor} />
      {stopLossPrice > 0 && (
        <Row label="Stop Loss" value={`$${stopLossPrice.toFixed(2)}`} className="text-amber-400" />
      )}
      {distToStop !== null && (
        <Row label="Dist. to Stop" value={`${distToStop}%`}
          className={parseFloat(distToStop) < 0.5 ? "text-red-400" : "text-gray-400"} />
      )}
    </div>
  );
}

function Row({ label, value, className = "text-gray-200" }: {
  label: string; value: string; className?: string;
}) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-[10px] text-gray-500">{label}</span>
      <span className={`text-[11px] ${className}`}>{value}</span>
    </div>
  );
}

// ── Win-Rate Heatmap ──────────────────────────────────────────────────────────

function WinRateHeatmap() {
  const winRateByPattern = useStore((s) => s.winRateByPattern);

  const hasData = Object.keys(winRateByPattern).length > 0;

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-[9px] border-collapse">
        <thead>
          <tr>
            <th className="text-left text-gray-600 font-normal pb-1 pr-2">Pattern</th>
            {ALL_REGIMES.map((r) => (
              <th key={r} className="text-gray-600 font-normal pb-1 px-1"
                style={{ color: REGIME_COLORS[r] }}>
                {r === "LowVol" ? "Low" : r === "HighVol" ? "High" : "Crisis"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ALL_PATTERNS.map((pattern) => (
            <tr key={pattern}>
              <td className="text-gray-400 font-mono pr-2 py-0.5 truncate max-w-[100px]"
                title={pattern}>
                {pattern.replace(/_/g, " ")}
              </td>
              {ALL_REGIMES.map((regime) => {
                const key   = `${pattern}:${regime}`;
                const entry = winRateByPattern[key];
                if (!hasData || !entry || entry.total === 0) {
                  return <td key={regime} className="text-center text-gray-700 py-0.5 px-1">—</td>;
                }
                const wr  = entry.wins / entry.total;
                const bg  = wr >= 0.55 ? "#34d399" : wr >= 0.45 ? "#fbbf24" : "#f87171";
                return (
                  <td key={regime} className="text-center py-0.5 px-1 rounded font-mono"
                    style={{ background: bg + "44", color: bg, border: `1px solid ${bg}33` }}
                    title={`${(wr * 100).toFixed(0)}% (n=${entry.total})`}>
                    {(wr * 100).toFixed(0)}%
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!hasData && <Empty>No trade outcomes yet</Empty>}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-[10px] text-gray-600">
      {children}
    </div>
  );
}
