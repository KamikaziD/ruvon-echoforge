"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { useStore, DistributionResult } from "@/lib/store";
import { computeDistributions } from "@/lib/distributions";
import { Upload, Filter } from "lucide-react";

// ── Reliability badge ─────────────────────────────────────────────────────────

function ReliabilityBadge({ r }: { r: "high" | "medium" | "low" }) {
  const styles = {
    high:   "bg-emerald-950/60 border-emerald-800 text-emerald-400",
    medium: "bg-amber-950/60   border-amber-800   text-amber-400",
    low:    "bg-gray-900/60    border-gray-700     text-gray-500",
  };
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase ${styles[r]}`}>
      {r === "high" ? `n≥30` : r === "medium" ? `n≥10` : `n<10`}
    </span>
  );
}

// ── Inline SVG box plot (200 × 54) ───────────────────────────────────────────

function BoxPlot({ d }: { d: DistributionResult }) {
  const W = 200; const H = 54; const PAD = 16;
  const plotW = W - PAD * 2;

  // Map value → x coordinate using whisker range
  const lo  = d.whiskers.lo;
  const hi  = d.whiskers.hi;
  const range = hi - lo || 1;
  const px = (v: number) => PAD + ((v - lo) / range) * plotW;

  const q1x    = px(d.q1);
  const q3x    = px(d.q3);
  const medX   = px(d.median);
  const loX    = Math.max(PAD, px(d.whiskers.lo));
  const hiX    = Math.min(W - PAD, px(d.whiskers.hi));
  const midY   = H / 2;
  const boxH   = 18;

  const boxColor = d.skewness > 0.2 ? "#34d399" : d.skewness < -0.2 ? "#f87171" : "#94a3b8";

  return (
    <svg width={W} height={H} className="block">
      {/* Zero reference line */}
      {lo < 0 && hi > 0 && (
        <line x1={px(0)} y1={4} x2={px(0)} y2={H - 4}
          stroke="#374151" strokeWidth={1} strokeDasharray="3 2" />
      )}
      {/* Whisker line */}
      <line x1={loX} y1={midY} x2={hiX} y2={midY} stroke="#4b5563" strokeWidth={1.5} />
      {/* Whisker caps */}
      <line x1={loX} y1={midY - 5} x2={loX} y2={midY + 5} stroke="#4b5563" strokeWidth={1.5} />
      <line x1={hiX} y1={midY - 5} x2={hiX} y2={midY + 5} stroke="#4b5563" strokeWidth={1.5} />
      {/* IQR box */}
      <rect x={q1x} y={midY - boxH / 2} width={Math.max(q3x - q1x, 2)} height={boxH}
        fill={`${boxColor}22`} stroke={boxColor} strokeWidth={1.5} rx={2} />
      {/* Median line */}
      <line x1={medX} y1={midY - boxH / 2} x2={medX} y2={midY + boxH / 2}
        stroke={boxColor} strokeWidth={2} />
      {/* Outlier dots */}
      {d.outliers.slice(0, 12).map((v, i) => (
        <circle key={i} cx={px(v)} cy={midY} r={2.5} fill="#6b7280" opacity={0.7} />
      ))}
    </svg>
  );
}

// ── Distribution row ──────────────────────────────────────────────────────────

function DistRow({ label, d }: { label: string; d: DistributionResult }) {
  const [hover, setHover] = useState(false);
  const [pid, regime] = label.split(":");

  return (
    <div
      className="relative border-b border-gray-800/50 py-2"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-mono text-gray-300 font-semibold">{pid}</span>
        <span className="text-[9px] px-1 py-0.5 rounded bg-gray-800 text-gray-500">{regime}</span>
        <ReliabilityBadge r={d.reliability} />
        <span className="text-[9px] text-gray-600 ml-auto">n={d.count}</span>
      </div>

      <BoxPlot d={d} />

      <div className="flex gap-3 text-[9px] font-mono text-gray-500 mt-1">
        <span>med <span className="text-gray-300">{d.median.toFixed(4)}</span></span>
        <span>iqr <span className="text-gray-400">{d.iqr.toFixed(4)}</span></span>
        <span className={d.skewness > 0.2 ? "text-emerald-500" : d.skewness < -0.2 ? "text-red-500" : "text-gray-400"}>
          skew {d.skewness > 0 ? "+" : ""}{d.skewness.toFixed(2)}
        </span>
        <span>cons <span className="text-gray-400">{d.consistency.toFixed(2)}</span></span>
      </div>
      {/* Beta-Bernoulli CI — only shown for live-computed distributions with wins data */}
      {d.wins !== undefined && (() => {
        const bA = 5 + d.wins;
        const bB = 5 + (d.count - d.wins);
        const bN = bA + bB;
        const pWin = bA / bN;
        const ci   = 1.96 * Math.sqrt((bA * bB) / (bN * bN * (bN + 1)));
        return (
          <p className="text-[9px] font-mono mt-0.5">
            <span className="text-violet-400">P(win) {(pWin * 100).toFixed(1)}%</span>
            <span className="text-gray-600"> ±{(ci * 100).toFixed(1)}%</span>
            <span className="text-gray-700"> ({d.wins}/{d.count})</span>
          </p>
        );
      })()}

      {/* Hover tooltip */}
      {hover && (
        <div className="absolute z-10 left-[210px] top-0 w-48 bg-gray-900 border border-gray-700 rounded p-2 text-[9px] font-mono space-y-0.5 shadow-xl">
          {[
            ["Mean",    d.mean.toFixed(5)],
            ["Median",  d.median.toFixed(5)],
            ["Q1",      d.q1.toFixed(5)],
            ["Q3",      d.q3.toFixed(5)],
            ["IQR",     d.iqr.toFixed(5)],
            ["Std",     d.std.toFixed(5)],
            ["Skewness",d.skewness.toFixed(4)],
            ["Consist.",d.consistency.toFixed(4)],
            ["W.Lo",    d.whiskers.lo.toFixed(5)],
            ["W.Hi",    d.whiskers.hi.toFixed(5)],
            ["Outliers",String(d.outliers.length)],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-gray-500">{k}</span>
              <span className="text-gray-200">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pattern Lab main component ────────────────────────────────────────────────

export function PatternLab() {
  const outcomes          = useStore((s) => s.outcomes);
  const setDistributions  = useStore((s) => s.setDistributions);

  // Compute live distributions from accumulated outcome records
  const liveDistributions = useMemo(
    () => computeDistributions(outcomes),
    [outcomes],
  );

  const [imported,   setImported]   = useState<Record<string, DistributionResult>>({});
  const [filterPid,  setFilterPid]  = useState("");
  const [filterReg,  setFilterReg]  = useState("");
  const [source,     setSource]     = useState<"live" | "import">("live");
  const fileRef = useRef<HTMLInputElement>(null);

  const distributions = source === "live" ? liveDistributions : imported;

  const handleFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        // Accept both a session export (has .distributions key) or a raw distributions object
        const dist = json.distributions ?? json;
        if (typeof dist === "object" && dist !== null) {
          setImported(dist as Record<string, DistributionResult>);
          setDistributions(dist as Record<string, DistributionResult>);
          setSource("import");
        }
      } catch { /* invalid JSON */ }
    };
    reader.readAsText(file);
  }, [setDistributions]);

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    const file = ev.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const allKeys    = Object.keys(distributions);
  const allPatterns = Array.from(new Set(allKeys.map((k) => k.split(":")[0]))).sort();
  const allRegimes  = Array.from(new Set(allKeys.map((k) => k.split(":")[1] ?? "Any"))).sort();

  const filtered = allKeys
    .filter((k) => {
      const [pid, reg] = k.split(":");
      return (!filterPid || pid === filterPid) && (!filterReg || (reg ?? "Any") === filterReg);
    })
    .filter((k) => distributions[k] !== null)
    .sort((a, b) => {
      const da = distributions[a]!;
      const db = distributions[b]!;
      return db.consistency - da.consistency;
    });

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">Pattern Lab</h2>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSource("live")}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              source === "live" ? "bg-emerald-950/60 border-emerald-800 text-emerald-400" : "border-gray-700 text-gray-500 hover:text-gray-300"
            }`}
          >
            Live
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-gray-700 text-gray-500 hover:text-gray-300 transition-colors"
          >
            <Upload size={9} /> Import
          </button>
          <input ref={fileRef} type="file" accept=".json" className="hidden"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
        </div>
      </div>

      {/* Filters */}
      {allKeys.length > 0 && (
        <div className="flex gap-2 shrink-0">
          <Filter size={10} className="text-gray-600 self-center" />
          <select
            value={filterPid} onChange={(e) => setFilterPid(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300"
          >
            <option value="">All patterns</option>
            {allPatterns.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={filterReg} onChange={(e) => setFilterReg(e.target.value)}
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300"
          >
            <option value="">All regimes</option>
            {allRegimes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      )}

      {/* Drop zone / content */}
      {allKeys.length === 0 ? (
        <div
          onDrop={onDrop} onDragOver={(e) => e.preventDefault()}
          className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-700 rounded-lg text-gray-600 gap-3 cursor-pointer hover:border-gray-600 transition-colors"
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={28} className="opacity-40" />
          <div className="text-center">
            <p className="text-sm">Drop session JSON here</p>
            <p className="text-xs mt-1 opacity-60">Or click to browse — export from EchoForge node</p>
          </div>
          <p className="text-[10px] opacity-40">Live distributions appear automatically once ≥3 outcomes recorded per pattern</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scroll-thin">
          {filtered.length === 0 ? (
            <p className="text-xs text-gray-600 text-center mt-8">No distributions match filters</p>
          ) : (
            filtered.map((k) => (
              <DistRow key={k} label={k} d={distributions[k]!} />
            ))
          )}
        </div>
      )}

      {/* Footer stats */}
      {allKeys.length > 0 && (
        <div className="flex gap-3 text-[9px] text-gray-600 shrink-0 border-t border-gray-800 pt-2">
          <span>{filtered.length}/{allKeys.length} distributions</span>
          <span>{filtered.filter((k) => distributions[k]?.reliability === "high").length} high-reliability</span>
          {source === "import" && <span className="text-amber-500/60">imported</span>}
        </div>
      )}
    </div>
  );
}
