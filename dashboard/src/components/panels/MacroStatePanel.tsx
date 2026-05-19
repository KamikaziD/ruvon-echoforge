"use client";

import { useStore, type MacroState } from "@/lib/store";

// ── Badge helpers ─────────────────────────────────────────────────────────────

type Tone = "neutral" | "green" | "amber" | "red" | "cyan" | "violet";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-gray-700 text-gray-500 bg-gray-900/30",
  green:   "border-emerald-700 text-emerald-400 bg-emerald-950/30",
  amber:   "border-amber-700 text-amber-400 bg-amber-950/30",
  red:     "border-red-700 text-red-400 bg-red-950/30",
  cyan:    "border-cyan-700 text-cyan-400 bg-cyan-950/30",
  violet:  "border-violet-700 text-violet-400 bg-violet-950/30",
};

function persistenceTone(tag: string): Tone {
  if (tag === "trending")  return "green";
  if (tag === "reverting") return "amber";
  return "neutral";
}
function cvdTone(tag: string): Tone {
  if (tag === "bearish_div") return "red";
  if (tag === "bullish_div") return "green";
  return "neutral";
}
function depthTone(tag: string): Tone {
  return tag === "thin" ? "amber" : "neutral";
}
function corrTone(tag: string): Tone {
  return tag === "depegged" ? "cyan" : "neutral";
}

function Badge({ label, value, tone, sub }: { label: string; value: string; tone: Tone; sub?: string }) {
  return (
    <div className={`flex flex-col gap-0.5 rounded border px-2.5 py-2 ${TONE_CLASS[tone]}`}>
      <span className="text-[9px] uppercase tracking-widest opacity-60">{label}</span>
      <span className="text-[11px] font-mono font-semibold">{value}</span>
      {sub && <span className="text-[9px] opacity-50 font-mono">{sub}</span>}
    </div>
  );
}

function HurstBar({ h }: { h: number | null | undefined }) {
  if (h == null) return <div className="h-1.5 rounded bg-gray-800 w-full" title="Hurst — warming up" />;
  const pct  = Math.max(0, Math.min(100, h * 100));
  const color = h > 0.55 ? "#34d399" : h < 0.45 ? "#fbbf24" : "#6b7280";
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between">
        <span className="text-[9px] text-gray-600">Hurst H</span>
        <span className="text-[9px] font-mono text-gray-400">{h.toFixed(3)}</span>
      </div>
      <div className="relative h-1.5 rounded bg-gray-800 overflow-hidden">
        {/* Reverting zone */}
        <div className="absolute left-0 top-0 h-full bg-amber-900/30" style={{ width: "45%" }} />
        {/* Trending zone */}
        <div className="absolute right-0 top-0 h-full bg-emerald-900/30" style={{ width: "45%" }} />
        {/* Cursor */}
        <div
          className="absolute top-0 h-full w-0.5 rounded"
          style={{ left: `${pct}%`, background: color, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between text-[8px] text-gray-700">
        <span>reverting</span>
        <span>random</span>
        <span>trending</span>
      </div>
    </div>
  );
}

// ── Warm-start status ─────────────────────────────────────────────────────────

function WarmingBanner() {
  return (
    <div className="flex items-center gap-2 rounded border border-amber-800/40 bg-amber-950/20 px-2.5 py-2">
      <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
      <span className="text-[10px] text-amber-400">Macro governor warming up — K-line replay in progress</span>
    </div>
  );
}

// ── Stale indicator ───────────────────────────────────────────────────────────

function staleSince(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 90)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function MacroStatePanel() {
  const macro = useStore((s) => s.macroState);

  if (!macro) return <WarmingBanner />;

  // Bridge-side fields (Hurst, CVD divergence, correlation) take ~60s to arrive.
  // Until then, fall back to safe neutral defaults so browser-computed fields
  // (depth, cvd_raw) are still visible immediately.
  const persistence  = macro.persistence  ?? "random";
  const cvd_div      = macro.cvd_div      ?? "neutral";
  const correlation  = macro.correlation  ?? "pegged";
  const bridgeReady  = !!(macro.persistence && macro.cvd_div && macro.correlation);

  const stale = Date.now() - macro.timestamp > 180_000;

  return (
    <div className="space-y-3">

      {!bridgeReady && (
        <div className="flex items-center gap-2 rounded border border-amber-800/40 bg-amber-950/20 px-2.5 py-2">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <span className="text-[10px] text-amber-400">Bridge macro computing — Hurst / CVD / correlation pending</span>
        </div>
      )}

      {stale && (
        <div className="flex items-center gap-2 rounded border border-amber-800/40 bg-amber-950/20 px-2 py-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <span className="text-[9px] text-amber-400">Macro state stale — last update {staleSince(macro.timestamp)}</span>
        </div>
      )}

      {/* 4 dimension badges */}
      <div className="grid grid-cols-2 gap-2">
        <Badge
          label="Persistence"
          value={persistence}
          tone={persistenceTone(persistence)}
          sub={macro.hurst != null ? `H = ${macro.hurst.toFixed(3)}` : "H pending"}
        />
        <Badge
          label="CVD Exhaustion"
          value={cvd_div.replace("_", " ")}
          tone={cvdTone(cvd_div)}
          sub={macro.cvd_raw != null ? `cvd_raw ${macro.cvd_raw.toFixed(1)}` : undefined}
        />
        <Badge
          label="Book Depth"
          value={macro.depth ?? "normal"}
          tone={depthTone(macro.depth ?? "normal")}
          sub={macro.depth_raw != null && macro.depth_ma != null
            ? `${macro.depth_raw.toFixed(2)} / MA ${macro.depth_ma.toFixed(2)}`
            : undefined}
        />
        <Badge
          label="Correlation"
          value={correlation}
          tone={corrTone(correlation)}
          sub={macro.last_vpin != null ? `vpin ${macro.last_vpin.toFixed(3)}` : undefined}
        />
      </div>

      {/* Hurst gauge */}
      <HurstBar h={macro.hurst} />

      {/* Buffer fill indicators */}
      <div className="flex gap-3 text-[9px] text-gray-600 font-mono">
        <span>Hurst buf: {macro.hurst_buf_n ?? 0}/3600</span>
        <span>CVD buf: {macro.cvd_buf_n ?? 0}/14400</span>
        <span className="ml-auto">{staleSince(macro.timestamp)}</span>
      </div>

    </div>
  );
}
