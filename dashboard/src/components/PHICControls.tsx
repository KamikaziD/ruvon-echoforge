"use client";

import { useState, useCallback } from "react";
import { useStore } from "@/lib/store";
import { pushPHIC, triggerFreeze, thawFreeze } from "@/lib/api";
import { Shield, ShieldOff, Plus, X, ChevronDown, ChevronUp, Eye, TrendingUp, Lightbulb, CheckCheck, XCircle, ShieldCheck, ShieldAlert } from "lucide-react";

export function PHICControls() {
  const phic               = useStore((s) => s.phic);
  const setPHIC            = useStore((s) => s.setPHIC);
  const freezePending      = useStore((s) => s.freezePending);
  const setFreeze          = useStore((s) => s.setFreezePending);
  const hurdleSuggestions  = useStore((s) => s.hurdleSuggestions);
  const setHurdleSuggestions = useStore((s) => s.setHurdleSuggestions);
  const currentRegime      = useStore((s) => s.currentRegime);
  const isHmmWarm          = useStore((s) => s.isHmmWarm);
  const guardianState      = useStore((s) => s.metrics.guardian_state);

  const [vetoInput,    setVetoInput]    = useState("");
  const [capKey,       setCapKey]       = useState("LowVol");
  const [capVal,       setCapVal]       = useState("1.0");
  const [expanded,     setExpanded]     = useState(true);
  const [pushErr,      setPushErr]      = useState<string | null>(null);

  const push = useCallback(async (patch: Partial<typeof phic>) => {
    const next = { ...phic, ...patch };
    setPHIC(patch);
    setPushErr(null);
    try {
      await pushPHIC(next);
    } catch (e) {
      setPushErr((e as Error).message);
    }
  }, [phic, setPHIC]);

  const onFreeze = async () => {
    setFreeze(true);
    try {
      await triggerFreeze();
      setPHIC({ emergency_freeze: true });
    } catch (e) {
      setPushErr((e as Error).message);
    } finally {
      setFreeze(false);
    }
  };

  const onThaw = async () => {
    setFreeze(true);
    try {
      await thawFreeze();
      setPHIC({ emergency_freeze: false });
    } catch (e) {
      setPushErr((e as Error).message);
    } finally {
      setFreeze(false);
    }
  };

  const setDaemonMode = async (observe: boolean) => {
    await push({ execution_disabled: observe });
  };

  const applyInsights = async () => {
    if (!hurdleSuggestions?.suggestions?.length) return;
    const strainOverride: Record<string, number> = {};
    for (const s of hurdleSuggestions.suggestions) {
      strainOverride[s.regime_tag] = s.suggested_strain;
    }
    await push({ regime_strain_exp: strainOverride });
    setHurdleSuggestions(null);
  };

  const addVeto = () => {
    const id = vetoInput.trim();
    if (!id || phic.vetoed_patterns.includes(id)) return;
    push({ vetoed_patterns: [...phic.vetoed_patterns, id] });
    setVetoInput("");
  };

  const removeVeto = (id: string) => {
    push({ vetoed_patterns: phic.vetoed_patterns.filter((v) => v !== id) });
  };

  const addCap = () => {
    const val = parseFloat(capVal);
    if (!capKey || isNaN(val)) return;
    push({ regime_caps: { ...phic.regime_caps, [capKey]: val } });
  };

  const removeCap = (k: string) => {
    const next = { ...phic.regime_caps };
    delete next[k];
    push({ regime_caps: next });
  };

  // Proactive overrides from HMM Navigator
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
    <aside className="flex flex-col gap-4 h-full overflow-y-auto scroll-thin">
      {/* Regime badge */}
      <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${regimeBadgeClass}`}>
        <div>
          <p className="text-[9px] uppercase tracking-widest opacity-60">HMM Regime</p>
          <p className="text-xs font-semibold font-mono">
            {isHmmWarm ? currentRegime : "Warming up…"}
          </p>
        </div>
        {proactive && (
          <div className="text-right text-[9px] font-mono opacity-70">
            <p>risk×{typeof proactive.risk_multiplier === "number"
              ? proactive.risk_multiplier.toFixed(1) : "—"}</p>
            {typeof proactive.ofi_bias === "number" && (
              <p className={proactive.ofi_bias >= 0 ? "text-emerald-400" : "text-red-400"}>
                OFI {proactive.ofi_bias >= 0 ? "+" : ""}{(proactive.ofi_bias as number).toFixed(3)}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Proactive overrides read-only */}
      {proactive && Object.keys(proactive).length > 0 && (
        <Section label="Navigator Overrides">
          <div className="space-y-1">
            {Object.entries(proactive).map(([k, v]) => (
              <div key={k} className="flex justify-between text-[10px] font-mono">
                <span className="text-gray-500">{k.replace(/_/g, " ")}</span>
                <span className="text-gray-300">
                  {typeof v === "number" ? v.toFixed(4) : String(v)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Title */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-widest uppercase text-gray-400">PHIC</h2>
        <button onClick={() => setExpanded(!expanded)} className="text-gray-500 hover:text-gray-300">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {/* Daemon mode toggle */}
      <div className="space-y-1.5">
        <p className="text-xs text-gray-500 uppercase tracking-wider">Daemon Mode</p>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            onClick={() => setDaemonMode(true)}
            className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
              phic.execution_disabled
                ? "border-cyan-600 bg-cyan-950/40 text-cyan-300"
                : "border-gray-700 bg-transparent text-gray-500 hover:border-gray-500 hover:text-gray-300"
            }`}
          >
            <Eye size={12} /> OBSERVE
          </button>
          <button
            onClick={() => setDaemonMode(false)}
            className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
              !phic.execution_disabled
                ? "border-emerald-600 bg-emerald-950/40 text-emerald-300"
                : "border-gray-700 bg-transparent text-gray-500 hover:border-gray-500 hover:text-gray-300"
            }`}
          >
            <TrendingUp size={12} /> TRADE
          </button>
        </div>
      </div>

      {/* Emergency freeze / thaw */}
      {phic.emergency_freeze ? (
        <button
          onClick={onThaw}
          disabled={freezePending}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-amber-600 bg-amber-950/40 px-3 py-2.5 text-sm font-semibold text-amber-300 hover:bg-amber-900/40 transition-colors disabled:opacity-50"
        >
          <ShieldOff size={14} />
          {freezePending ? "Thawing…" : "THAW — Resume Trading"}
        </button>
      ) : (
        <button
          onClick={onFreeze}
          disabled={freezePending}
          className="w-full flex items-center justify-center gap-2 rounded-lg border border-red-700 bg-red-950/30 px-3 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50 active:scale-95"
        >
          <Shield size={14} />
          {freezePending ? "Freezing…" : "EMERGENCY FREEZE"}
        </button>
      )}

      {pushErr && (
        <p className="text-xs text-red-400 bg-red-950/20 border border-red-800/40 rounded px-2 py-1">{pushErr}</p>
      )}

      {!expanded && (
        <p className="text-xs text-gray-600">Controls collapsed. Click ↑ to expand.</p>
      )}

      {expanded && (
        <>
          {/* Autonomy slider */}
          <Section label="Autonomy Level" badge={`${Math.round(phic.autonomy_level * 100)}%`}>
            <input
              type="range" min={0} max={1} step={0.05}
              value={phic.autonomy_level}
              onChange={(e) => push({ autonomy_level: parseFloat(e.target.value) })}
              className="w-full accent-emerald-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0% Manual</span>
              <span>100% Full Auto</span>
            </div>
          </Section>

          {/* Max position */}
          <Section label="Max Position %" badge={`${Math.round(phic.max_position_pct)}%`}>
            <input
              type="range" min={1} max={100} step={1}
              value={phic.max_position_pct}
              onChange={(e) => push({ max_position_pct: parseFloat(e.target.value) })}
              className="w-full accent-blue-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>1%</span><span>100%</span>
            </div>
          </Section>

          {/* Max drawdown */}
          <Section label="Max Drawdown %" badge={`${phic.max_drawdown_pct.toFixed(1)}%`}>
            <input
              type="range" min={1} max={50} step={1}
              value={phic.max_drawdown_pct}
              onChange={(e) => push({ max_drawdown_pct: parseFloat(e.target.value) })}
              className="w-full accent-red-500 cursor-pointer"
            />
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[10px] text-gray-600">Freeze after</span>
              <input
                type="number" min={1} max={10} step={1}
                value={phic.drawdown_hysteresis_n ?? 3}
                onChange={(e) => push({ drawdown_hysteresis_n: parseInt(e.target.value) })}
                className="w-12 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none"
              />
              <span className="text-[10px] text-gray-600">consecutive samples</span>
            </div>
          </Section>

          {/* Pattern exposure cap */}
          <Section label="Pattern Exposure Cap" badge={`${((phic.max_pattern_exposure_pct ?? 0.30) * 100).toFixed(0)}%`}>
            <input
              type="range" min={0} max={1} step={0.05}
              value={phic.max_pattern_exposure_pct ?? 0.30}
              onChange={(e) => push({ max_pattern_exposure_pct: parseFloat(e.target.value) })}
              className="w-full accent-orange-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0% Off</span>
              <span>100% No cap</span>
            </div>
          </Section>

          {/* Total aggregate exposure cap */}
          <Section label="Total Exposure Cap" badge={`${((phic.max_total_exposure_pct ?? 0.20) * 100).toFixed(0)}%`}>
            <input
              type="range" min={0} max={1} step={0.05}
              value={phic.max_total_exposure_pct ?? 0.20}
              onChange={(e) => push({ max_total_exposure_pct: parseFloat(e.target.value) })}
              className="w-full accent-red-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0% Off</span>
              <span>100% No cap</span>
            </div>
            <p className="text-[9px] text-gray-600 mt-1">Hard ceiling across all patterns combined</p>
          </Section>

          <Section label="Stop-Loss" badge={`${(phic.stop_loss_pct ?? 1.5).toFixed(2)}% / off@0`}>
            <input
              type="range" min={0} max={10} step={0.05}
              value={phic.stop_loss_pct ?? 1.5}
              onChange={(e) => push({ stop_loss_pct: parseFloat(e.target.value) })}
              className="w-full accent-orange-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0 Off</span><span>10%</span>
            </div>
            <p className="text-[9px] text-gray-600 mt-1">Sell 50% when price drops this % below avg entry</p>
          </Section>

          {/* Profit Banking */}
          <Section label="Profit Banking">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">Bank threshold</span>
                <input type="range" min={0} max={0.1} step={0.005}
                  value={phic.bank_profit_threshold_pct ?? 0.019}
                  onChange={(e) => push({ bank_profit_threshold_pct: parseFloat(e.target.value) })}
                  className="flex-1 accent-emerald-500 cursor-pointer" />
                <span className="text-[10px] font-mono text-emerald-400 w-10 text-right">
                  {((phic.bank_profit_threshold_pct ?? 0.019) * 100).toFixed(2)}%
                </span>
              </div>
              <p className="text-[9px] text-gray-600">Gain above HWM that triggers Tier 1 banking</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">Tier 1 fraction</span>
                <input type="range" min={0} max={1} step={0.05}
                  value={phic.bank_tier1_frac ?? 0.50}
                  onChange={(e) => push({ bank_tier1_frac: parseFloat(e.target.value) })}
                  className="flex-1 accent-emerald-500 cursor-pointer" />
                <span className="text-[10px] font-mono text-emerald-400 w-10 text-right">
                  {Math.round((phic.bank_tier1_frac ?? 0.50) * 100)}%
                </span>
              </div>
              <p className="text-[9px] text-gray-600">Fraction banked immediately at threshold</p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">T2 dwell (min)</span>
                <input
                  type="number" min={1} max={60} step={1}
                  value={phic.bank_profit_dwell_min ?? 10}
                  onChange={(e) => push({ bank_profit_dwell_min: parseInt(e.target.value) })}
                  className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs text-gray-200 text-center focus:outline-none"
                />
                <span className="text-[10px] text-gray-600">min before fallback</span>
              </div>
            </div>
          </Section>

          {/* Fidelity / AI Jury */}
          <Section label="Fidelity / AI Jury" badge={`${Math.round((phic.inference_fidelity ?? 0.70) * 100)}%`}>
            <input
              type="range" min={0} max={1} step={0.05}
              value={phic.inference_fidelity ?? 0.70}
              onChange={(e) => push({ inference_fidelity: parseFloat(e.target.value) })}
              className="w-full accent-violet-500 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-gray-600 mt-0.5">
              <span>0% (1 worker)</span><span>100% (max jury)</span>
            </div>
            <p className="text-[9px] text-gray-600 mt-1">Scales inference workers proportional to CPU cores</p>
          </Section>

          {/* Guardian Worker */}
          <Section label="Guardian">
            {/* State badge row */}
            <div className="flex items-center gap-2 mb-2">
              {(["NOMINAL", "CAUTIOUS", "REDUCE_ONLY", "HALTED"] as const).map((s) => {
                const colors: Record<string, string> = {
                  NOMINAL:      "border-emerald-600 bg-emerald-950/40 text-emerald-300",
                  CAUTIOUS:     "border-amber-600   bg-amber-950/40   text-amber-300",
                  REDUCE_ONLY:  "border-orange-600  bg-orange-950/40  text-orange-300",
                  HALTED:       "border-red-700     bg-red-950/30     text-red-400",
                };
                const inactive = "border-gray-800 bg-transparent text-gray-600";
                return (
                  <span key={s}
                    className={`flex-1 text-center rounded border px-1 py-0.5 text-[9px] font-semibold font-mono transition-colors ${guardianState === s ? colors[s] : inactive}`}
                  >{s.replace("_", " ")}</span>
                );
              })}
            </div>
            {/* Mode toggle */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => push({ guardian_mode: "shadow" })}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                  (phic.guardian_mode ?? "shadow") === "shadow"
                    ? "border-cyan-600 bg-cyan-950/40 text-cyan-300"
                    : "border-gray-700 bg-transparent text-gray-500 hover:border-gray-500 hover:text-gray-300"
                }`}
              ><Eye size={11} /> SHADOW</button>
              <button
                onClick={() => push({ guardian_mode: "active" })}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition-colors ${
                  phic.guardian_mode === "active"
                    ? "border-emerald-600 bg-emerald-950/40 text-emerald-300"
                    : "border-gray-700 bg-transparent text-gray-500 hover:border-gray-500 hover:text-gray-300"
                }`}
              >{phic.guardian_mode === "active" ? <ShieldCheck size={11} /> : <ShieldAlert size={11} />} ACTIVE</button>
            </div>
            <p className="text-[9px] text-gray-600 mt-1">
              {phic.guardian_mode === "active"
                ? "Active: enforces conflict limits and circuit breakers"
                : "Shadow: logs decisions, never blocks trades"}
            </p>
          </Section>

          {/* Correlation thresholds */}
          <Section label="Correlation" badge={phic.correlation_enabled === false ? "OFF" : "ON"}>
            <div className="flex items-center gap-2 mb-2">
              <button
                onClick={() => push({ correlation_enabled: true })}
                className={`flex-1 rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${phic.correlation_enabled !== false ? "border-emerald-600 bg-emerald-950/40 text-emerald-300" : "border-gray-700 text-gray-500 hover:border-gray-500"}`}
              >ON</button>
              <button
                onClick={() => push({ correlation_enabled: false })}
                className={`flex-1 rounded border px-2 py-1 text-[10px] font-semibold transition-colors ${phic.correlation_enabled === false ? "border-red-700 bg-red-950/30 text-red-400" : "border-gray-700 text-gray-500 hover:border-gray-500"}`}
              >OFF</button>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">RVR threshold</span>
                <input type="range" min={0.5} max={3} step={0.05}
                  value={phic.rvr_threshold ?? 1.5}
                  onChange={(e) => push({ rvr_threshold: parseFloat(e.target.value) })}
                  className="flex-1 accent-yellow-500 cursor-pointer" />
                <span className="text-[10px] font-mono text-yellow-400 w-8 text-right">{(phic.rvr_threshold ?? 1.5).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">Pearson threshold</span>
                <input type="range" min={0.1} max={0.9} step={0.05}
                  value={phic.pearson_threshold ?? 0.5}
                  onChange={(e) => push({ pearson_threshold: parseFloat(e.target.value) })}
                  className="flex-1 accent-cyan-500 cursor-pointer" />
                <span className="text-[10px] font-mono text-cyan-400 w-8 text-right">{(phic.pearson_threshold ?? 0.5).toFixed(2)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-600 w-24 shrink-0">Cross-pair boost</span>
                <input type="range" min={0} max={0.1} step={0.005}
                  value={phic.cross_pair_boost ?? 0.04}
                  onChange={(e) => push({ cross_pair_boost: parseFloat(e.target.value) })}
                  className="flex-1 accent-purple-500 cursor-pointer" />
                <span className="text-[10px] font-mono text-purple-400 w-8 text-right">{(phic.cross_pair_boost ?? 0.04).toFixed(3)}</span>
              </div>
            </div>
          </Section>

          {/* Veto list */}
          <Section label="Vetoed Patterns" badge={String(phic.vetoed_patterns.length)}>
            <div className="flex gap-1.5">
              <input
                value={vetoInput}
                onChange={(e) => setVetoInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addVeto()}
                placeholder="pattern_id"
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500"
              />
              <button onClick={addVeto} className="text-gray-400 hover:text-emerald-400 transition-colors">
                <Plus size={14} />
              </button>
            </div>
            {phic.vetoed_patterns.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {phic.vetoed_patterns.map((id) => (
                  <div key={id} className="flex items-center justify-between bg-gray-800/60 rounded px-2 py-1">
                    <span className="text-xs font-mono text-red-300 truncate">{id}</span>
                    <button onClick={() => removeVeto(id)} className="text-gray-600 hover:text-red-400 ml-2">
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Regime caps */}
          <Section label="Regime Caps" badge={`${Object.keys(phic.regime_caps).length} rules`}>
            <div className="flex gap-1.5">
              <select
                value={capKey}
                onChange={(e) => setCapKey(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
              >
                {["LowVol", "HighVol", "Crisis", "Any"].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <input
                type="number" min={0} max={1} step={0.1}
                value={capVal}
                onChange={(e) => setCapVal(e.target.value)}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none"
              />
              <button onClick={addCap} className="text-gray-400 hover:text-blue-400 transition-colors">
                <Plus size={14} />
              </button>
            </div>
            {Object.entries(phic.regime_caps).length > 0 && (
              <div className="mt-1.5 space-y-1">
                {Object.entries(phic.regime_caps).map(([regime, cap]) => (
                  <div key={regime} className="flex items-center justify-between bg-gray-800/60 rounded px-2 py-1">
                    <span className="text-xs font-mono text-gray-300">{regime}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-blue-400">{cap}</span>
                      <button onClick={() => removeCap(regime)} className="text-gray-600 hover:text-red-400">
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Metabolic insights */}
          <Section
            label="Metabolic Insights"
            badge={hurdleSuggestions ? `${hurdleSuggestions.log_size ?? 0} trades · ${hurdleSuggestions.window_hours ?? 0}h` : undefined}
          >
            {!hurdleSuggestions ? (
              <p className="text-[10px] text-gray-600">Accumulating signal history…</p>
            ) : (
              <div className="space-y-1">
                {(hurdleSuggestions.suggestions ?? []).map((s, i) => (
                  <div key={i} className="flex items-start gap-2 bg-gray-800/50 rounded px-2 py-1.5">
                    <Lightbulb size={11} className={s.action === "raise_strain" ? "text-amber-400 mt-0.5 shrink-0" : "text-emerald-400 mt-0.5 shrink-0"} />
                    <div className="min-w-0">
                      <p className="text-[10px] font-mono text-gray-300 truncate">
                        {s.regime_tag} · {s.strategy_type}
                      </p>
                      <p className="text-[10px] text-gray-500">
                        {s.action === "raise_strain" ? "hurdle too loose" : "hurdle too tight"} — win {(s.win_rate_pct ?? 0).toFixed(0)}% (n={s.n ?? "?"})
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
                      <span className="text-red-400 text-[10px] shrink-0 mt-0.5">⊗</span>
                      <p className="text-[10px] text-red-300/80">
                        {c.regime_tag}·{c.pattern_id ?? c.strategy_type ?? "?"} — {c.detail ?? "dead echo · consider pruning"}
                      </p>
                    </div>
                  ) : (
                    <div key={`sc-${i}`} className="flex items-start gap-2 bg-gray-800/30 rounded px-2 py-1.5 border border-cyan-900/40">
                      <span className="text-cyan-400 text-[10px] shrink-0 mt-0.5">✦</span>
                      <p className="text-[10px] text-cyan-300/80">
                        {c.regime_tag}·{c.strategy_type ?? ""} split by {c.dimension ?? "?"}{c.sub_a && c.sub_b ? ` (${c.sub_a.label} ${(c.sub_a.win_rate * 100).toFixed(0)}% vs ${c.sub_b.label} ${(c.sub_b.win_rate * 100).toFixed(0)}%)` : ""} — {c.detail ?? ""}
                      </p>
                    </div>
                  )
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={applyInsights}
                    className="flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 border border-emerald-800/50 rounded px-2 py-1 transition-colors"
                  >
                    <CheckCheck size={10} /> Apply
                  </button>
                  <button
                    onClick={() => setHurdleSuggestions(null)}
                    className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 border border-gray-700 rounded px-2 py-1 transition-colors"
                  >
                    <XCircle size={10} /> Dismiss
                  </button>
                </div>
              </div>
            )}
          </Section>
        </>
      )}
    </aside>
  );
}

function Section({ label, badge, children }: { label: string; badge?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
        {badge && <span className="text-[10px] text-gray-600 font-mono">{badge}</span>}
      </div>
      {children}
    </div>
  );
}
