"use client";

import { useState, useCallback, useEffect } from "react";
import { useStore } from "@/lib/store";
import { pushPHIC, triggerFreeze, thawFreeze } from "@/lib/api";
import { PHIC_PRESETS, type PresetName, type Preset } from "@/lib/phicPresets";
import {
  Shield, ShieldOff, Plus, X, Eye, TrendingUp, Lightbulb,
  CheckCheck, XCircle, ShieldCheck, ShieldAlert, ChevronDown, ChevronRight,
  RotateCcw, Brain,
} from "lucide-react";

// ── Accordion section ─────────────────────────────────────────────────────────

function Accordion({
  label, badge, defaultOpen = false, children,
}: {
  label: string; badge?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-800/60 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-900/60 hover:bg-gray-800/60 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={10} className="text-gray-500" /> : <ChevronRight size={10} className="text-gray-500" />}
          <span className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold">{label}</span>
        </div>
        {badge && <span className="text-[9px] font-mono text-gray-600">{badge}</span>}
      </button>
      {open && <div className="px-3 py-3 space-y-3 bg-gray-900/20">{children}</div>}
    </div>
  );
}

function SliderRow({
  label, min, max, step, value, onChange, formatVal, accent = "accent-emerald-500", hint,
}: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (v: number) => void; formatVal?: (v: number) => string;
  accent?: string; hint?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-gray-500 shrink-0">{label}</span>
        <div className="flex items-center gap-2 flex-1">
          <input type="range" min={min} max={max} step={step} value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className={`flex-1 cursor-pointer ${accent}`} />
          <span className="text-[10px] font-mono text-gray-300 w-16 text-right">
            {formatVal ? formatVal(value) : value}
          </span>
        </div>
      </div>
      {hint && <p className="text-[9px] text-gray-600">{hint}</p>}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-gray-500 shrink-0 w-28">{label}</span>
      {children}
    </div>
  );
}

function SectionHint({ children }: { children: React.ReactNode }) {
  return <p className="text-[9px] text-gray-600 mt-0.5">{children}</p>;
}

// ── Main component ────────────────────────────────────────────────────────────

export function PHICControls() {
  const phic               = useStore((s) => s.phic);
  const setPHIC            = useStore((s) => s.setPHIC);
  const freezePending      = useStore((s) => s.freezePending);
  const setFreeze          = useStore((s) => s.setFreezePending);
  const hurdleSuggestions  = useStore((s) => s.hurdleSuggestions);
  const setHurdleSuggestions = useStore((s) => s.setHurdleSuggestions);
  const currentRegime        = useStore((s) => s.currentRegime);
  const isHmmWarm            = useStore((s) => s.isHmmWarm);
  const guardianState        = useStore((s) => s.metrics.guardian_state);
  const configVersion        = useStore((s) => s.configVersion);
  const regressionInsights   = useStore((s) => s.regressionInsights);

  const [vetoInput,  setVetoInput]  = useState("");
  const [capKey,     setCapKey]     = useState("LowVol");
  const [capVal,     setCapVal]     = useState("1.0");
  const [pushErr,    setPushErr]    = useState<string | null>(null);
  const [autoApply,  setAutoApply]  = useState(true);

  const push = useCallback(async (patch: Partial<typeof phic>) => {
    const next = { ...phic, ...patch };
    setPHIC(patch);
    setPushErr(null);
    try { await pushPHIC(next); }
    catch (e) { setPushErr((e as Error).message); }
  }, [phic, setPHIC]);

  const onFreeze = async () => {
    setFreeze(true);
    try { await triggerFreeze(); setPHIC({ emergency_freeze: true }); }
    catch (e) { setPushErr((e as Error).message); }
    finally { setFreeze(false); }
  };

  const onThaw = async () => {
    setFreeze(true);
    try { await thawFreeze(); setPHIC({ emergency_freeze: false }); }
    catch (e) { setPushErr((e as Error).message); }
    finally { setFreeze(false); }
  };

  const applyInsights = useCallback(async () => {
    if (!hurdleSuggestions?.suggestions?.length) return;
    const strainOverride: Record<string, number> = {};
    for (const s of hurdleSuggestions.suggestions) strainOverride[s.regime_tag] = s.suggested_strain;
    await push({ regime_strain_exp: strainOverride });
    setHurdleSuggestions(null);
  }, [hurdleSuggestions, push, setHurdleSuggestions]);

  // Auto-apply: fires when new suggestions arrive (or when auto-apply is turned on with pending suggestions)
  useEffect(() => {
    if (!autoApply || !hurdleSuggestions?.suggestions?.length) return;
    const strainOverride: Record<string, number> = {};
    for (const s of hurdleSuggestions.suggestions) strainOverride[s.regime_tag] = s.suggested_strain;
    push({ regime_strain_exp: strainOverride }).then(() => setHurdleSuggestions(null));
  }, [hurdleSuggestions, autoApply]); // eslint-disable-line react-hooks/exhaustive-deps

  const addVeto = () => {
    const id = vetoInput.trim();
    if (!id || phic.vetoed_patterns.includes(id)) return;
    push({ vetoed_patterns: [...phic.vetoed_patterns, id] });
    setVetoInput("");
  };

  const removeVeto = (id: string) => push({ vetoed_patterns: phic.vetoed_patterns.filter((v) => v !== id) });

  const addCap = () => {
    const val = parseFloat(capVal);
    if (!capKey || isNaN(val)) return;
    push({ regime_caps: { ...phic.regime_caps, [capKey]: val } });
  };

  const removeCap = (k: string) => {
    const next = { ...phic.regime_caps }; delete next[k]; push({ regime_caps: next });
  };

  // Presets: start with local fallback, replace with server values once loaded.
  // Server values come from echoforge.config.yaml via GET /api/v1/phic/presets.
  const [presets, setPresets] = useState<Record<PresetName, Preset>>(PHIC_PRESETS);
  useEffect(() => {
    const bridgeUrl = (process.env.NEXT_PUBLIC_BRIDGE_URL ?? "http://localhost:8765").replace(/\/$/, "");
    fetch(`${bridgeUrl}/api/v1/phic/presets`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setPresets(data as Record<PresetName, Preset>); })
      .catch(() => { /* bridge unreachable — keep local fallback */ });
  }, []);

  const [activePreset, setActivePreset] = useState<PresetName | null>(null);
  const applyPreset = useCallback(async (name: PresetName) => {
    await push(presets[name].config);
    setActivePreset(name);
  }, [push, presets]);

  const proactive = (phic as unknown as Record<string, unknown>).proactive_overrides as Record<string, unknown> | undefined;
  const REGIME_COLORS: Record<string, string> = {
    LowVol:  "text-emerald-400 border-emerald-800 bg-emerald-950/40",
    HighVol: "text-amber-400   border-amber-800   bg-amber-950/40",
    Crisis:  "text-red-400     border-red-800     bg-red-950/40",
  };
  const regimeBadgeClass = isHmmWarm
    ? (REGIME_COLORS[currentRegime] ?? "text-gray-400 border-gray-700")
    : "text-gray-500 border-gray-700 bg-transparent";

  return (
    <div className="flex flex-col gap-3">

      {/* Config version + regime status */}
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-xs font-mono font-semibold ${regimeBadgeClass}`}>
          {isHmmWarm ? currentRegime : "Warming…"}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-gray-600 font-mono">Config v{configVersion}</span>
          <button
            title="Rollback to previous config (not yet implemented — requires regression optimizer)"
            className="text-gray-700 hover:text-gray-500 transition-colors cursor-not-allowed"
          >
            <RotateCcw size={11} />
          </button>
        </div>
      </div>

      {/* Emergency freeze button */}
      {phic.emergency_freeze ? (
        <button onClick={onThaw} disabled={freezePending}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-600 bg-amber-950/40 px-3 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-900/40 transition-colors disabled:opacity-50">
          <ShieldOff size={14} />{freezePending ? "Thawing…" : "THAW — Resume Trading"}
        </button>
      ) : (
        <button onClick={onFreeze} disabled={freezePending}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-700 bg-red-950/30 px-3 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 active:scale-95">
          <Shield size={14} />{freezePending ? "Freezing…" : "EMERGENCY FREEZE"}
        </button>
      )}

      {pushErr && <p className="text-xs text-red-400 bg-red-950/20 border border-red-800/40 rounded px-2 py-1">{pushErr}</p>}

      {/* Presets */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-gray-600 uppercase tracking-wider">Preset</p>
        <div className="grid grid-cols-3 gap-1">
          {(["low", "medium", "high"] as PresetName[]).map((name) => {
            const { label, hint } = presets[name] ?? PHIC_PRESETS[name];
            const active = activePreset === name;
            const colorClass = name === "low"
              ? active ? "border-emerald-600 bg-emerald-950/50 text-emerald-300" : "border-gray-700 text-gray-500 hover:border-emerald-800 hover:text-emerald-500"
              : name === "medium"
              ? active ? "border-blue-600 bg-blue-950/50 text-blue-300"         : "border-gray-700 text-gray-500 hover:border-blue-800 hover:text-blue-500"
              :          active ? "border-amber-600 bg-amber-950/50 text-amber-300"   : "border-gray-700 text-gray-500 hover:border-amber-800 hover:text-amber-500";
            return (
              <button key={name} onClick={() => applyPreset(name)} title={hint}
                className={`rounded px-2 py-1.5 text-[10px] font-semibold border transition-colors ${colorClass}`}>
                {label}
              </button>
            );
          })}
        </div>
        {activePreset && (
          <p className="text-[9px] text-gray-600">{(presets[activePreset] ?? PHIC_PRESETS[activePreset]).hint}</p>
        )}
      </div>

      {/* Daemon mode */}
      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={() => push({ execution_disabled: true })}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
            phic.execution_disabled ? "border-cyan-600 bg-cyan-950/40 text-cyan-300" : "border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300"}`}>
          <Eye size={12} /> OBSERVE
        </button>
        <button onClick={() => push({ execution_disabled: false })}
          className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
            !phic.execution_disabled ? "border-emerald-600 bg-emerald-950/40 text-emerald-300" : "border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300"}`}>
          <TrendingUp size={12} /> TRADE
        </button>
      </div>

      {/* Proactive overrides (read-only) */}
      {proactive && Object.keys(proactive).length > 0 && (
        <div className="bg-gray-900/40 border border-gray-800 rounded p-2 space-y-1">
          <p className="text-[9px] uppercase tracking-widest text-gray-600">Navigator Overrides</p>
          {Object.entries(proactive).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[10px] font-mono">
              <span className="text-gray-500">{k.replace(/_/g, " ")}</span>
              <span className="text-gray-300">{typeof v === "number" ? v.toFixed(4) : String(v)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── ACCORDION: Risk ─────────────────────────────────────────────────── */}
      <Accordion label="Risk" defaultOpen badge={`${Math.round(phic.max_drawdown_pct)}% DD · ${Math.round(phic.max_position_pct)}% pos`}>
        <SliderRow label="Max Position %" min={1} max={100} step={1} value={phic.max_position_pct}
          onChange={(v) => push({ max_position_pct: v })} formatVal={(v) => `${Math.round(v)}%`}
          accent="accent-blue-500" hint="Single-order size ceiling as % of portfolio" />
        <SliderRow label="Pattern Exposure" min={0} max={1} step={0.05} value={phic.max_pattern_exposure_pct ?? 0.30}
          onChange={(v) => push({ max_pattern_exposure_pct: v })} formatVal={(v) => `${(v * 100).toFixed(0)}%`}
          accent="accent-orange-500" hint="Max % of portfolio any single pattern may hold" />
        <SliderRow label="Total Exposure" min={0} max={1} step={0.05} value={phic.max_total_exposure_pct ?? 0.20}
          onChange={(v) => push({ max_total_exposure_pct: v })} formatVal={(v) => `${(v * 100).toFixed(0)}%`}
          accent="accent-red-500" hint="Hard cap across ALL patterns combined" />
        <SliderRow label="Max Drawdown %" min={1} max={50} step={1} value={phic.max_drawdown_pct}
          onChange={(v) => push({ max_drawdown_pct: v })} formatVal={(v) => `${v.toFixed(1)}%`}
          accent="accent-red-500" />
        <FieldRow label="Freeze after">
          <input type="number" min={1} max={10} step={1} value={phic.drawdown_hysteresis_n ?? 3}
            onChange={(e) => push({ drawdown_hysteresis_n: parseInt(e.target.value) })}
            className="w-12 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none" />
          <span className="text-[10px] text-gray-600">consecutive breaches</span>
        </FieldRow>
        <SliderRow label="Stop-Loss %" min={0} max={10} step={0.05} value={phic.stop_loss_pct ?? 1.5}
          onChange={(v) => push({ stop_loss_pct: v })} formatVal={(v) => v === 0 ? "off" : `${v.toFixed(2)}%`}
          accent="accent-orange-500" hint="Sell 50% when price drops this % below avg cost (0 = off)" />
        <SliderRow label="Kelly Payoff Ratio" min={1.0} max={4.0} step={0.1} value={phic.kelly_payoff_ratio ?? 1.5}
          onChange={(v) => push({ kelly_payoff_ratio: v })} formatVal={(v) => `${v.toFixed(1)}×`}
          hint="Expected win/loss size ratio — b in f*=(p·b−(1−p))/b. Higher = larger sizing at same pUp." />

        {/* Regime caps */}
        <div className="space-y-1.5 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">Regime Caps ({Object.keys(phic.regime_caps).length})</p>
          <div className="flex gap-1.5">
            <select value={capKey} onChange={(e) => setCapKey(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-200 focus:outline-none">
              {["LowVol", "HighVol", "Crisis", "Any"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <input type="number" min={0} max={1} step={0.1} value={capVal}
              onChange={(e) => setCapVal(e.target.value)}
              className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-200 focus:outline-none" />
            <button onClick={addCap} className="text-gray-500 hover:text-blue-400 transition-colors"><Plus size={13} /></button>
          </div>
          {Object.entries(phic.regime_caps).map(([regime, cap]) => (
            <div key={regime} className="flex items-center justify-between bg-gray-800/60 rounded px-2 py-1">
              <span className="text-[10px] font-mono text-gray-300">{regime}</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-blue-400">{cap}</span>
                <button onClick={() => removeCap(regime)} className="text-gray-600 hover:text-red-400"><X size={10} /></button>
              </div>
            </div>
          ))}
        </div>
      </Accordion>

      {/* ── ACCORDION: Profit ───────────────────────────────────────────────── */}
      <Accordion label="Profit" badge={`T1 ${((phic.bank_tier1_frac ?? 0.50) * 100).toFixed(0)}% · auto ${Math.round((phic.autonomy_level ?? 0.90) * 100)}%`}>
        <SliderRow label="Autonomy" min={0} max={1} step={0.05} value={phic.autonomy_level}
          onChange={(v) => push({ autonomy_level: v })} formatVal={(v) => `${Math.round(v * 100)}%`}
          accent="accent-emerald-500" hint="0% = fully manual, 100% = full autonomous execution" />
        <div className="space-y-1.5 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">Profit Banking</p>
          <SliderRow label="Bank threshold" min={0} max={0.1} step={0.005} value={phic.bank_profit_threshold_pct ?? 0.019}
            onChange={(v) => push({ bank_profit_threshold_pct: v })} formatVal={(v) => `${(v * 100).toFixed(2)}%`}
            accent="accent-emerald-500" hint="Gain above HWM that triggers Tier 1 banking" />
          <SliderRow label="Tier 1 fraction" min={0} max={1} step={0.05} value={phic.bank_tier1_frac ?? 0.50}
            onChange={(v) => push({ bank_tier1_frac: v })} formatVal={(v) => `${Math.round(v * 100)}%`}
            accent="accent-emerald-500" />
          <FieldRow label="T2 dwell (min)">
            <input type="number" min={1} max={60} step={1} value={phic.bank_profit_dwell_min ?? 10}
              onChange={(e) => push({ bank_profit_dwell_min: parseInt(e.target.value) })}
              className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none" />
            <span className="text-[10px] text-gray-600">min before fallback banking</span>
          </FieldRow>
        </div>

        {/* Vetoed patterns */}
        <div className="space-y-1.5 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">Vetoed Patterns ({phic.vetoed_patterns.length})</p>
          <div className="flex gap-1.5">
            <input value={vetoInput} onChange={(e) => setVetoInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addVeto()} placeholder="PATTERN_ID"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-[10px] text-gray-200 placeholder-gray-600 focus:outline-none" />
            <button onClick={addVeto} className="text-gray-500 hover:text-red-400 transition-colors"><Plus size={13} /></button>
          </div>
          {phic.vetoed_patterns.map((id) => (
            <div key={id} className="flex items-center justify-between bg-red-950/20 border border-red-900/30 rounded px-2 py-1">
              <span className="text-[10px] font-mono text-red-300 truncate">{id}</span>
              <button onClick={() => removeVeto(id)} className="text-gray-600 hover:text-red-400 ml-2"><X size={10} /></button>
            </div>
          ))}
        </div>
      </Accordion>

      {/* ── ACCORDION: Execution ────────────────────────────────────────────── */}
      <Accordion label="Execution" badge={`guardian ${phic.guardian_mode ?? "shadow"} · fidelity ${Math.round((phic.inference_fidelity ?? 0.70) * 100)}%`}>
        {/* Guardian */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {(["NOMINAL", "CAUTIOUS", "REDUCE_ONLY", "HALTED"] as const).map((s) => {
              const colors: Record<string, string> = {
                NOMINAL:      "border-emerald-600 bg-emerald-950/40 text-emerald-300",
                CAUTIOUS:     "border-amber-600   bg-amber-950/40   text-amber-300",
                REDUCE_ONLY:  "border-orange-600  bg-orange-950/40  text-orange-300",
                HALTED:       "border-red-700     bg-red-950/30     text-red-400",
              };
              return (
                <span key={s} className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold font-mono transition-colors ${
                  guardianState === s ? colors[s] : "border-gray-800 text-gray-600"}`}>
                  {s.replace("_", " ")}
                </span>
              );
            })}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => push({ guardian_mode: "shadow" })}
              className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                phic.guardian_mode !== "active" ? "border-cyan-600 bg-cyan-950/40 text-cyan-300" : "border-gray-700 text-gray-500"}`}>
              <Eye size={11} /> SHADOW
            </button>
            <button onClick={() => push({ guardian_mode: "active" })}
              className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                phic.guardian_mode === "active" ? "border-emerald-600 bg-emerald-950/40 text-emerald-300" : "border-gray-700 text-gray-500"}`}>
              {phic.guardian_mode === "active" ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />} ACTIVE
            </button>
          </div>
        </div>

        <SliderRow label="AI Fidelity" min={0} max={1} step={0.05} value={phic.inference_fidelity ?? 0.70}
          onChange={(v) => push({ inference_fidelity: v })} formatVal={(v) => `${Math.round(v * 100)}%`}
          accent="accent-violet-500" hint="Scales inference jury workers proportional to CPU cores" />

        {/* Correlation */}
        <div className="space-y-2 pt-1 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">Correlation</p>
            <div className="flex gap-1">
              <button onClick={() => push({ correlation_enabled: true })}
                className={`rounded border px-2 py-0.5 text-[9px] font-bold transition-colors ${phic.correlation_enabled !== false ? "border-emerald-600 bg-emerald-950/40 text-emerald-300" : "border-gray-700 text-gray-500"}`}>ON</button>
              <button onClick={() => push({ correlation_enabled: false })}
                className={`rounded border px-2 py-0.5 text-[9px] font-bold transition-colors ${phic.correlation_enabled === false ? "border-red-700 bg-red-950/30 text-red-400" : "border-gray-700 text-gray-500"}`}>OFF</button>
            </div>
          </div>
          <SliderRow label="RVR threshold" min={0.5} max={3} step={0.05} value={phic.rvr_threshold ?? 1.5}
            onChange={(v) => push({ rvr_threshold: v })} formatVal={(v) => v.toFixed(2)}
            accent="accent-yellow-500" />
          <SliderRow label="Pearson threshold" min={0.1} max={0.9} step={0.05} value={phic.pearson_threshold ?? 0.5}
            onChange={(v) => push({ pearson_threshold: v })} formatVal={(v) => v.toFixed(2)}
            accent="accent-cyan-500" />
          <SliderRow label="Cross-pair boost" min={0} max={0.1} step={0.005} value={phic.cross_pair_boost ?? 0.04}
            onChange={(v) => push({ cross_pair_boost: v })} formatVal={(v) => v.toFixed(3)}
            accent="accent-purple-500" />
        </div>

        {/* Regression Insights — live */}
        <div className="space-y-1.5 pt-1 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Brain size={10} className="text-violet-400" />
              <p className="text-[9px] uppercase tracking-widest text-violet-400">Regression Insights</p>
            </div>
            {phic.regression_override && (
              <span className="text-[8px] font-bold text-amber-400 bg-amber-950/40 border border-amber-700/40 rounded px-1 py-0.5">REVERTED</span>
            )}
          </div>
          {Object.keys(regressionInsights).length === 0 ? (
            <div className="bg-violet-950/20 border border-violet-900/30 rounded p-2 text-[9px] font-mono text-gray-600">
              pending data — need ≥50 outcomes per strategy type
            </div>
          ) : (
            <div className="bg-violet-950/20 border border-violet-900/30 rounded p-1.5 space-y-0.5">
              {Object.entries(regressionInsights)
                .sort((a, b) => b[1].n - a[1].n)
                .map(([stype, info]) => {
                  const r2Color = info.r2 >= 0.5 ? "text-emerald-400" : info.r2 >= 0.3 ? "text-yellow-400" : "text-gray-500";
                  const lastMs  = info.last_update_ms;
                  const lastStr = lastMs > 0 ? new Date(lastMs).toLocaleTimeString() : "—";
                  return (
                    <div key={stype} className="flex items-center justify-between font-mono text-[9px]">
                      <span className="text-gray-400 w-24 truncate">{stype}</span>
                      <span className={`${r2Color} w-14 text-right`}>R²={info.r2.toFixed(3)}</span>
                      <span className="text-gray-600 w-12 text-right">n={info.n}</span>
                      <span className="text-gray-700 w-16 text-right text-[8px]">{lastStr}</span>
                    </div>
                  );
                })}
              {(phic.regression_last_applied_ms ?? 0) > 0 && (
                <p className="text-[8px] text-violet-500/70 pt-0.5 border-t border-violet-900/20">
                  last push {new Date(phic.regression_last_applied_ms!).toLocaleTimeString()}
                </p>
              )}
            </div>
          )}
        </div>
      </Accordion>

      {/* ── ACCORDION: Sentinels ────────────────────────────────────────────── */}
      <Accordion label="Sentinels" badge={`ceil ${phic.latency_passive_ceiling_ms ?? 150}ms`}>
        {/* Network */}
        <div className="space-y-2">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">Network / Latency</p>
          <SliderRow label="Passive ceiling" min={50} max={500} step={10} value={phic.latency_passive_ceiling_ms ?? 150}
            onChange={(v) => push({ latency_passive_ceiling_ms: v })} formatVal={(v) => `${v}ms`}
            accent="accent-cyan-500" hint="Latency above → FORCE_PASSIVE (stop execution)" />
          <SliderRow label="Halt ceiling" min={100} max={2000} step={50} value={phic.halted_latency_ms ?? 500}
            onChange={(v) => push({ halted_latency_ms: v })} formatVal={(v) => `${v}ms`}
            accent="accent-red-500" hint="Latency above → Guardian HALTED (manual reset required)" />
          <SliderRow label="Clock skew" min={10} max={200} step={5} value={phic.clock_skew_ceiling_ms ?? 50}
            onChange={(v) => push({ clock_skew_ceiling_ms: v })} formatVal={(v) => `${v}ms`}
            accent="accent-yellow-500" hint="Clock skew above → FORCE_PASSIVE" />
        </div>

        {/* Calibration safety */}
        <div className="space-y-2 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">Calibration Safety</p>
          <SliderRow label="Crisis ceiling" min={0.50} max={1.0} step={0.01} value={phic.max_crisis_threshold ?? 0.90}
            onChange={(v) => push({ max_crisis_threshold: v })} formatVal={(v) => v.toFixed(2)}
            accent="accent-red-500" hint="Hard ceiling on calibrated VPIN crisis threshold" />
          <SliderRow label="Strain NACK" min={0.10} max={1.0} step={0.05} value={phic.strain_nack_threshold ?? 0.60}
            onChange={(v) => push({ strain_nack_threshold: v })} formatVal={(v) => `${Math.round(v * 100)}%`}
            accent="accent-amber-500" hint="Strain ratio above which Guardian NACKs that pattern" />
          <FieldRow label="Cool (min) / VPIN rcv (min)">
            <input type="number" min={1} max={30} step={1} value={phic.strain_cooldown_min ?? 5}
              onChange={(e) => push({ strain_cooldown_min: parseInt(e.target.value) })}
              className="w-10 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none" />
            <span className="text-[10px] text-gray-600">/</span>
            <input type="number" min={1} max={15} step={1} value={phic.vpin_recovery_min ?? 3}
              onChange={(e) => push({ vpin_recovery_min: parseInt(e.target.value) })}
              className="w-10 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none" />
          </FieldRow>
        </div>

        {/* VPIN tuning */}
        <div className="space-y-2 pt-1 border-t border-gray-800">
          <p className="text-[9px] text-gray-600 uppercase tracking-wider">VPIN Tuning</p>
          <SliderRow label="HighVol threshold" min={0.20} max={0.65} step={0.05} value={phic.vpin_highvol_threshold ?? 0.35}
            onChange={(v) => push({ vpin_highvol_threshold: v })} formatVal={(v) => v.toFixed(2)}
            hint="VPIN above → HighVol regime; calibration overwrites unless locked" />
          <SliderRow label="VPIN EWMA α" min={0.005} max={0.10} step={0.005} value={phic.vpin_ewma_alpha ?? 0.02}
            onChange={(v) => push({ vpin_ewma_alpha: v })} formatVal={(v) => v.toFixed(3)}
            hint="Smoothing factor — lower = slower, reduces LowVol↔Crisis bimodal" />
          <SliderRow label="Auto-thaw (min)" min={1} max={30} step={1} value={phic.auto_thaw_minutes ?? 5}
            onChange={(v) => push({ auto_thaw_minutes: v })} formatVal={(v) => `${v}m`}
            hint="Minutes of calm VPIN before a sentinel freeze auto-thaws" />
        </div>

        {/* Metabolic insights */}
        <div className="space-y-2 pt-1 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">Metabolic Insights</p>
            <div className="flex items-center gap-2">
              {hurdleSuggestions && (
                <span className="text-[9px] font-mono text-gray-600">{hurdleSuggestions.log_size ?? 0} trades · {hurdleSuggestions.window_hours ?? 0}h</span>
              )}
              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoApply}
                  onChange={(e) => setAutoApply(e.target.checked)}
                  className="w-3 h-3 accent-emerald-500 cursor-pointer"
                />
                <span className={`text-[9px] font-medium ${autoApply ? "text-emerald-400" : "text-gray-500"}`}>auto</span>
              </label>
            </div>
          </div>
          {!hurdleSuggestions ? (
            <p className="text-[10px] text-gray-600">Accumulating signal history…</p>
          ) : (
            <div className="space-y-1">
              {(hurdleSuggestions.suggestions ?? []).map((s, i) => (
                <div key={i} className="flex items-start gap-2 bg-gray-800/50 rounded px-2 py-1.5">
                  <Lightbulb size={10} className={s.action === "raise_strain" ? "text-amber-400 mt-0.5 shrink-0" : "text-emerald-400 mt-0.5 shrink-0"} />
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono text-gray-300 truncate">{s.regime_tag} · {s.strategy_type}</p>
                    <p className="text-[9px] text-gray-500">
                      {s.action === "raise_strain" ? "too loose" : "too tight"} — win {(s.win_rate_pct ?? 0).toFixed(0)}% (n={s.n ?? "?"})
                      <span className={`ml-1 font-mono ${s.action === "raise_strain" ? "text-amber-400" : "text-emerald-400"}`}>
                        → {(s.suggested_strain ?? 0).toFixed(2)}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
              {(hurdleSuggestions.split_candidates ?? []).map((c, i) =>
                c.basis === "prune_candidate" ? (
                  <div key={`sc-${i}`} className="flex items-start gap-2 bg-red-950/30 rounded px-2 py-1.5 border border-red-900/40">
                    <span className="text-red-400 text-[10px] shrink-0">⊗</span>
                    <p className="text-[10px] text-red-300/80">{c.regime_tag}·{c.pattern_id ?? c.strategy_type ?? "?"} — {c.detail ?? "dead echo · consider pruning"}</p>
                  </div>
                ) : (
                  <div key={`sc-${i}`} className="flex items-start gap-2 bg-gray-800/30 rounded px-2 py-1.5 border border-cyan-900/40">
                    <span className="text-cyan-400 text-[10px] shrink-0">✦</span>
                    <p className="text-[10px] text-cyan-300/80">
                      {c.regime_tag}·{c.strategy_type ?? ""} split by {c.dimension ?? "?"}{c.sub_a && c.sub_b ? ` (${c.sub_a.label} ${(c.sub_a.win_rate * 100).toFixed(0)}% vs ${c.sub_b.label} ${(c.sub_b.win_rate * 100).toFixed(0)}%)` : ""} — {c.detail ?? ""}
                    </p>
                  </div>
                )
              )}
              {!autoApply && (
                <div className="flex gap-2 pt-1">
                  <button onClick={applyInsights}
                    className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 border border-emerald-800/50 rounded px-2 py-1 transition-colors">
                    <CheckCheck size={10} /> Apply
                  </button>
                  <button onClick={() => setHurdleSuggestions(null)}
                    className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-2 py-1 transition-colors">
                    <XCircle size={10} /> Dismiss
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </Accordion>

      {/* Macro Governor */}
      <Accordion label="Macro Governor" badge={phic.macro_enabled !== false ? "enabled" : "disabled"}>
        <div className="space-y-2">
          <FieldRow label="Enabled">
            <button
              onClick={() => push({ macro_enabled: !(phic.macro_enabled !== false) })}
              className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                phic.macro_enabled !== false
                  ? "border-emerald-700 text-emerald-400 bg-emerald-950/30"
                  : "border-gray-700 text-gray-500"
              }`}
            >
              {phic.macro_enabled !== false ? "ON" : "OFF"}
            </button>
          </FieldRow>
          <SectionHint>Pre-multiplies the hurdle before VPIN/strain — macro state sets the helicopter view.</SectionHint>

          <div className="space-y-2 pt-1 border-t border-gray-800">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">Hurst Persistence</p>
            <SliderRow label="Trending H" min={0.50} max={0.70} step={0.01}
              value={phic.hurst_trending_threshold ?? 0.55}
              onChange={(v) => push({ hurst_trending_threshold: v })}
              formatVal={(v) => v.toFixed(2)}
              accent="accent-emerald-500" hint="H above → trending — momentum/breakout hurdle ×0.75" />
            <SliderRow label="Reverting H" min={0.30} max={0.50} step={0.01}
              value={phic.hurst_reverting_threshold ?? 0.45}
              onChange={(v) => push({ hurst_reverting_threshold: v })}
              formatVal={(v) => v.toFixed(2)}
              accent="accent-amber-500" hint="H below → reverting — reversion hurdle ×0.75, breakout ×4" />
            <SliderRow label="Window (min)" min={1} max={60} step={1}
              value={phic.hurst_window_min ?? 8}
              onChange={(v) => push({ hurst_window_min: v })}
              formatVal={(v) => `${v}m`}
              hint="Minimum minutes of 1s-sampled price history before H is computed" />
          </div>

          <div className="space-y-2 pt-1 border-t border-gray-800">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">CVD Exhaustion</p>
            <SliderRow label="Lookback (min)" min={30} max={480} step={30}
              value={phic.cvd_lookback_min ?? 240}
              onChange={(v) => push({ cvd_lookback_min: v })}
              formatVal={(v) => `${v}m`}
              hint="4h rolling window for buy/sell CVD divergence detection" />
            <SliderRow label="Divergence threshold" min={0.01} max={0.50} step={0.01}
              value={phic.cvd_divergence_threshold ?? 0.15}
              onChange={(v) => push({ cvd_divergence_threshold: v })}
              formatVal={(v) => v.toFixed(2)}
              accent="accent-violet-500" hint="Normalised CVD/price prominence for bearish or bullish divergence" />
          </div>

          <div className="space-y-2 pt-1 border-t border-gray-800">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">Book Density</p>
            <SliderRow label="Thin book (% of MA)" min={0.20} max={0.80} step={0.05}
              value={phic.depth_thin_pct ?? 0.50}
              onChange={(v) => push({ depth_thin_pct: v })}
              formatVal={(v) => `${Math.round(v * 100)}%`}
              accent="accent-red-500" hint="±1% depth below this fraction of 24h MA and VPIN < 0.35 → thin" />
            <SliderRow label="Kelly thin scale" min={0.10} max={1.0} step={0.05}
              value={phic.macro_kelly_thin_scale ?? 0.50}
              onChange={(v) => push({ macro_kelly_thin_scale: v })}
              formatVal={(v) => `${Math.round(v * 100)}%`}
              hint="Kelly sizing multiplier in thin-book regime (DEPTH_GRAB is always vetoed)" />
          </div>

          <div className="space-y-2 pt-1 border-t border-gray-800">
            <p className="text-[9px] text-gray-600 uppercase tracking-wider">Structural Correlation</p>
            <SliderRow label="De-peg threshold" min={0.10} max={0.70} step={0.05}
              value={phic.correlation_depeg_threshold ?? 0.40}
              onChange={(v) => push({ correlation_depeg_threshold: v })}
              formatVal={(v) => v.toFixed(2)}
              accent="accent-cyan-500" hint="BTC/ETH 1h Pearson below → de-pegged; WHALE_WAKE hurdle ×0.75" />
            <SliderRow label="Corr window (h)" min={1} max={12} step={1}
              value={phic.correlation_window_h ?? 1}
              onChange={(v) => push({ correlation_window_h: v })}
              formatVal={(v) => `${v}h`}
              hint="Rolling window for BTC/ETH Pearson accumulation" />
          </div>
        </div>
      </Accordion>
    </div>
  );
}
