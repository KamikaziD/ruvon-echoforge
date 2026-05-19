"use client";

import { create } from "zustand";

// ── Distribution types (mirrors browser/utils/stats.js) ──────────────────────

export interface DistributionResult {
  count:       number;
  reliability: "high" | "medium" | "low";
  mean:        number;
  median:      number;
  q1:          number;
  q3:          number;
  iqr:         number;
  whiskers:    { lo: number; hi: number };
  outliers:    number[];
  skewness:    number;
  std:         number;
  consistency: number;
  wins?:       number;  // count of positive outcomes — present in live-computed distributions
}

export interface DriftAlert {
  id:                string;
  pattern_id:        string;
  slope:             number;
  r2:                number;
  time_to_zero_min:  number;
  timestamp:         number;
}

export interface OutcomeRecord {
  pattern_id:    string;
  strategy_type: string;
  regime_tag:    string;
  outcome_score: number;
  vpin?:         number;
  timestamp:     number;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface EchoEntry {
  pattern_id:       string;
  regime_tag:       string;
  net_aliveness:    number;
  shadow_aliveness: number;
  decay_rate:       number;
  execution_count:  number;
  last_updated:     number;
  state:            "active" | "hibernating" | "dead";
  contested:        boolean;
  peer_avg:         number | null;
  peer_count:       number;
  strain_count:     number;
  paper_depth:      number;
  // Phase 6 — Beta-Bernoulli posterior
  success_prob?:    number | null;
  ci95_width?:      number | null;
  beta_n?:          number;
}

export interface SentinelAlert {
  id:            string;
  sentinel_type: "Nociceptor" | "Proprioceptor" | "Metabolic";
  action:        string;
  severity:      number;
  detail:        string;
  timestamp:     number;
}

export interface PeerScore {
  node_id:     string;
  s_ex:        number;
  latency_ms:  number;
  isSovereign: boolean;
}

export interface ExecutionEvent {
  id:         string;
  pattern_id: string;
  type:       "submitted" | "failed" | "saf_queued" | "routed";
  detail:     string;
  timestamp:  number;
}

export interface NodeMetrics {
  vpin:                number;
  toxic:               boolean;
  exchange_latency_ms: number;
  is_passive:          boolean;
  peers:               number;
  connected:           boolean;
  sovereign_node_id:   string;
  is_sovereign:        boolean;
  s_ex:                number;
  saf_pending:         number;
  success_rate:        number;
  is_rate_limited:     boolean;
  guardian_state:      "NOMINAL" | "CAUTIOUS" | "REDUCE_ONLY" | "HALTED";
  guardian_mode:       "shadow" | "active";
}

export interface Position {
  coin:           number;
  avg_cost:       number;
  realized_pnl:   number;
  unrealized_pnl: number;
  current_price:  number;
  value:          number;
  trade_count:    number;
  wins:           number;
}

export interface Portfolio {
  usdt:           number;
  btc:            number;
  avg_cost:       number;
  realized_pnl:   number;
  unrealized_pnl: number;
  total_value:    number;
  total_pnl:      number;
  positions?:     Record<string, Position>;
}

export interface PHICConfig {
  autonomy_level:          number;
  vetoed_patterns:         string[];
  regime_caps:             Record<string, number>;
  emergency_freeze:        boolean;
  max_position_pct:        number;
  min_consensus_pct:       number;
  max_drawdown_pct:        number;
  execution_disabled:      boolean;
  regime_strain_exp?:      Record<string, number>;
  hurdle_regime_scale?:    Record<string, number>;
  max_pattern_exposure_pct: number;
  max_total_exposure_pct:   number;
  drawdown_hysteresis_n:   number;
  correlation_enabled:     boolean;
  rvr_threshold:           number;
  pearson_threshold:       number;
  cross_pair_boost:        number;
  stop_loss_pct:           number;
  stop_loss_sell_frac?:         number;
  stop_loss_buy_freeze_ms?:     number;
  cap_trim_buy_freeze_ms?:      number;
  stop_loss_reentry_buffer?:    number;
  kelly_payoff_ratio?:          number;
  bank_profit_threshold_pct?:   number;
  bank_tier1_frac?:             number;
  bank_profit_dwell_min?:       number;
  inference_fidelity?:          number;
  guardian_mode?:               "shadow" | "active";
  jury_entropy_threshold?:      number;
  mesh_heat_threshold?:         number;
  house_money_threshold?:       number;
  house_lock_frac?:             number;
  rolling_sharpe_floor?:        number;
  max_crisis_threshold?:        number;
  strain_nack_threshold?:       number;
  strain_cooldown_min?:         number;
  vpin_recovery_min?:           number;
  reduce_only_lowvol_frac?:     number;
  regime_dwell_min?:            number;
  vpin_crisis_threshold?:       number;
  vpin_highvol_threshold?:      number;
  vpin_hysteresis?:             number;
  vpin_ewma_alpha?:             number;
  auto_thaw_minutes?:           number;
  freeze_recovery_dwell_min?:   number;
  freeze_recovery_slip_pct?:    number;
  freeze_recovery_warmup_min?:  number;
  sl_circuit_breaker_n?:        number;
  sl_circuit_breaker_window_min?: number;
  dca_aliveness_floor?:         number;
  signal_boost?:                number;
  paper_shadow_alpha?:          number;
  paper_min_trades?:            number;
  latency_passive_ceiling_ms?:  number;
  clock_skew_ceiling_ms?:       number;
  halted_latency_ms?:           number;
  regression_override?:         boolean;
  regression_last_applied_ms?:  number;
  // Macro regime governor
  macro_enabled?:               boolean;
  hurst_trending_threshold?:    number;
  hurst_reverting_threshold?:   number;
  hurst_window_min?:            number;
  cvd_lookback_min?:            number;
  cvd_divergence_threshold?:    number;
  depth_thin_pct?:              number;
  depth_window_h?:              number;
  correlation_depeg_threshold?: number;
  correlation_window_h?:        number;
  macro_kelly_thin_scale?:      number;
}

export interface HurdleSuggestion {
  regime_tag:       string;
  strategy_type:    string;
  action:           "raise_strain" | "ease_strain";
  win_rate_pct:     number;
  n:                number;
  current_strain:   number;
  suggested_strain: number;
}

export interface HurdleSplitCandidate {
  regime_tag:     string;
  strategy_type?: string;
  dimension?:     string;
  split_by?:      string;
  basis?:         string;
  detail?:        string;
  pattern_id?:    string;   // set on prune_candidate entries
  state?:         string;   // "dead" | "hibernating" — set on prune_candidate entries
  sub_a?:         { label: string; win_rate: number; n: number };
  sub_b?:         { label: string; win_rate: number; n: number };
}

export interface HurdleSuggestionPayload {
  suggestions:      HurdleSuggestion[];
  split_candidates: HurdleSplitCandidate[];
  log_size:         number;
  window_hours:     number;
}

export interface MacroState {
  persistence:   "trending" | "random" | "reverting";
  cvd_div:       "bearish_div" | "bullish_div" | "neutral";
  correlation:   "depegged" | "pegged";
  depth:         "thin" | "normal";
  hurst:         number | null | undefined;
  cvd_raw:       number | null | undefined;
  depth_raw:     number | null | undefined;
  depth_ma:      number | null | undefined;
  last_vpin:     number | null | undefined;
  hurst_buf_n:   number | undefined;
  cvd_buf_n:     number | undefined;
  pearson_raw:   number | undefined;
  timestamp:     number;
}

// ── Store ────────────────────────────────────────────────────────────────────

interface EchoForgeStore {
  // Connection
  connected:     boolean;
  wsError:       string | null;

  // Live metrics from bridge
  metrics:       NodeMetrics;
  echoes:        EchoEntry[];
  alerts:        SentinelAlert[];
  scoreTable:    PeerScore[];
  execLog:       ExecutionEvent[];

  // PHIC state (mirrors server + local optimistic)
  phic:               PHICConfig;
  freezePending:      boolean;
  hurdleSuggestions:  HurdleSuggestionPayload | null;

  // VPIN history for chart (last 120 points)
  vpinHistory:   { t: number; v: number }[];

  // Portfolio / P&L
  portfolio:     Portfolio;

  // Trading Deck — equity curve + regime history
  equityHistory:    { t: number; v: number }[];
  regimeHistory:    { t: number; regime: string }[];
  currentRegime:    string;
  isHmmWarm:        boolean;
  winRateByPattern: Record<string, { wins: number; total: number }>;
  l2Depth:          { bids: [number, number][]; asks: [number, number][] };

  // Phase 2 additions
  outcomes:         OutcomeRecord[];
  distributions:    Record<string, DistributionResult>;
  driftAlerts:      DriftAlert[];
  configVersion:    number;

  // Phase 5 — regression optimizer
  regressionInsights: Record<string, { r2: number; n: number; buf_n?: number; min_samples?: number; last_update_ms: number }>;

  // Macro regime state (from bridge macro_state broadcast)
  macroState: MacroState | null;

  // Daemon ghost-mode status — true when daemon is running but execution_disabled=true
  daemonWaitingForStart: boolean;

  // Actions
  setConnected:     (v: boolean) => void;
  setWsError:       (e: string | null) => void;
  applyMetrics:     (patch: Partial<NodeMetrics>) => void;
  setEchoes:        (list: EchoEntry[]) => void;
  pushAlert:        (a: Omit<SentinelAlert, "id">) => void;
  setScoreTable:    (rows: PeerScore[]) => void;
  pushExecEvent:    (ev: Omit<ExecutionEvent, "id">) => void;
  setPHIC:               (cfg: Partial<PHICConfig>) => void;
  setFreezePending:      (v: boolean) => void;
  pushVPIN:              (vpin: number) => void;
  setPortfolio:          (p: Partial<Portfolio>) => void;
  setHurdleSuggestions:  (payload: HurdleSuggestionPayload | null) => void;
  pushEquity:       (point: { t: number; v: number }) => void;
  pushRegime:       (point: { t: number; regime: string }) => void;
  setRegime:        (regime: string) => void;
  setHmmWarm:       (warm: boolean) => void;
  recordTrade:      (patternId: string, regimeTag: string, won: boolean) => void;
  setL2Depth:       (depth: { bids: [number, number][]; asks: [number, number][] }) => void;
  pushOutcome:      (rec: OutcomeRecord) => void;
  setDistributions: (d: Record<string, DistributionResult>) => void;
  pushDriftAlert:        (a: Omit<DriftAlert, "id">) => void;
  bumpConfigVersion:     () => void;
  setRegressionInsights: (insights: Record<string, { r2: number; n: number; last_update_ms: number }>) => void;
  setMacroState: (s: MacroState) => void;
  setDaemonWaitingForStart: (v: boolean) => void;
}

const DEFAULT_METRICS: NodeMetrics = {
  vpin: 0, toxic: false,
  exchange_latency_ms: 0, is_passive: false,
  peers: 0, connected: false,
  sovereign_node_id: "—", is_sovereign: true, s_ex: 0,
  saf_pending: 0, success_rate: 1.0, is_rate_limited: false,
  guardian_state: "NOMINAL", guardian_mode: "shadow",
};

// Medium preset values — overridden immediately on bridge connect via PHICClient
const DEFAULT_PHIC: PHICConfig = {
  autonomy_level:              0.85,
  vetoed_patterns:             [],
  regime_caps:                 { LowVol: 0.8, HighVol: 1.0, Crisis: 0.0 },
  hurdle_regime_scale:         { LowVol: 0.70, HighVol: 0.95, Crisis: 1.75 },
  emergency_freeze:            false,
  max_position_pct:            15,
  min_consensus_pct:           60,
  max_drawdown_pct:            8,
  execution_disabled:          false,
  max_pattern_exposure_pct:    0.10,
  max_total_exposure_pct:      0.20,
  drawdown_hysteresis_n:       3,
  correlation_enabled:         true,
  rvr_threshold:               1.2,
  pearson_threshold:           0.45,
  cross_pair_boost:            0.04,
  stop_loss_pct:               2.0,
  stop_loss_sell_frac:         0.45,
  stop_loss_buy_freeze_ms:     600_000,
  cap_trim_buy_freeze_ms:      180_000,
  stop_loss_reentry_buffer:    0.010,
  kelly_payoff_ratio:          1.5,
  bank_profit_threshold_pct:   0.012,
  bank_tier1_frac:             0.60,
  bank_profit_dwell_min:       10,
  inference_fidelity:          0.70,
  guardian_mode:               "active",
  jury_entropy_threshold:      0.40,
  mesh_heat_threshold:         0.80,
  house_money_threshold:       100,
  house_lock_frac:             0.50,
  rolling_sharpe_floor:        -0.7,
  max_crisis_threshold:        0.90,
  strain_nack_threshold:       0.60,
  strain_cooldown_min:         5,
  vpin_recovery_min:           3,
  reduce_only_lowvol_frac:     0.25,
  regime_dwell_min:            5,
  vpin_crisis_threshold:       0.85,
  vpin_highvol_threshold:      0.50,
  vpin_hysteresis:             0.08,
  vpin_ewma_alpha:             0.02,
  auto_thaw_minutes:           5,
  freeze_recovery_dwell_min:   15,
  freeze_recovery_slip_pct:    1.0,
  freeze_recovery_warmup_min:  10,
  sl_circuit_breaker_n:        2,
  sl_circuit_breaker_window_min: 30,
  dca_aliveness_floor:         0.80,
  signal_boost:                0.03,
  paper_shadow_alpha:          0.10,
  paper_min_trades:            4,
  latency_passive_ceiling_ms:  150,
  clock_skew_ceiling_ms:       50,
  halted_latency_ms:           500,
};

const DEFAULT_PORTFOLIO: Portfolio = {
  usdt: 10_000, btc: 0, avg_cost: 0,
  realized_pnl: 0, unrealized_pnl: 0, total_value: 10_000, total_pnl: 0,
};

export const useStore = create<EchoForgeStore>((set) => ({
  connected:     false,
  wsError:       null,
  metrics:       DEFAULT_METRICS,
  echoes:        [],
  alerts:        [],
  scoreTable:    [],
  execLog:       [],
  phic:               DEFAULT_PHIC,
  freezePending:      false,
  hurdleSuggestions:  null,
  vpinHistory:        [],
  portfolio:          DEFAULT_PORTFOLIO,
  equityHistory:      [],
  regimeHistory:      [],
  currentRegime:      "LowVol",
  isHmmWarm:          true,   // true by default — Python HMM bridge is optional
  winRateByPattern:   {},
  l2Depth:            { bids: [], asks: [] },
  // Phase 2
  outcomes:           [],
  distributions:      {},
  driftAlerts:        [],
  configVersion:      1,
  // Phase 5
  regressionInsights: {},
  // Macro
  macroState: null,
  daemonWaitingForStart: false,

  setConnected:     (v) => set({ connected: v }),
  setWsError:       (e) => set({ wsError: e }),
  applyMetrics:     (patch) => set((s) => ({ metrics: { ...s.metrics, ...patch } })),
  setEchoes: (list) => set((s) => {
    // Merge by last_updated — keyed by "pattern_id:regime_tag" so LowVol and HighVol variants
    // of the same pattern are distinct entries (not collapsed into one)
    const key = (e: EchoEntry) => `${e.pattern_id}:${e.regime_tag}`;
    const map = new Map(s.echoes.map((e) => [key(e), e]));
    for (const e of list) {
      const existing = map.get(key(e));
      if (!existing || e.last_updated >= existing.last_updated) map.set(key(e), e);
    }
    return { echoes: Array.from(map.values()) };
  }),
  pushAlert:        (a) => set((s) => ({
    alerts: [{ ...a, id: crypto.randomUUID() }, ...s.alerts].slice(0, 200),
  })),
  setScoreTable:    (scoreTable) => set({ scoreTable }),
  pushExecEvent:    (ev) => set((s) => ({
    execLog: [{ ...ev, id: crypto.randomUUID() }, ...s.execLog].slice(0, 500),
  })),
  setPHIC:          (cfg) => set((s) => ({ phic: { ...s.phic, ...cfg } })),
  setFreezePending: (v) => set({ freezePending: v }),
  pushVPIN:         (vpin) => set((s) => ({
    vpinHistory: [...s.vpinHistory, { t: Date.now(), v: vpin }].slice(-120),
  })),
  setPortfolio:         (p) => set((s) => ({ portfolio: { ...s.portfolio, ...p } })),
  setHurdleSuggestions: (payload) => set({ hurdleSuggestions: payload }),
  pushEquity:  (point) => set((s) => ({
    equityHistory: [...s.equityHistory, point].slice(-500),
  })),
  pushRegime:  (point) => set((s) => ({
    regimeHistory: [...s.regimeHistory, point].slice(-200),
  })),
  setRegime:   (regime) => set({ currentRegime: regime }),
  setHmmWarm:  (warm)   => set({ isHmmWarm: warm }),
  recordTrade: (patternId, regimeTag, won) => set((s) => {
    const key   = `${patternId}:${regimeTag}`;
    const prev  = s.winRateByPattern[key] ?? { wins: 0, total: 0 };
    return {
      winRateByPattern: {
        ...s.winRateByPattern,
        [key]: { wins: prev.wins + (won ? 1 : 0), total: prev.total + 1 },
      },
    };
  }),
  setL2Depth:  (depth) => set({ l2Depth: depth }),
  // Phase 2 actions
  pushOutcome: (rec) => set((s) => ({
    outcomes: [...s.outcomes, rec].slice(-2000),
  })),
  setDistributions: (d) => set({ distributions: d }),
  pushDriftAlert: (a) => set((s) => ({
    driftAlerts: [{ ...a, id: crypto.randomUUID() }, ...s.driftAlerts].slice(0, 50),
  })),
  bumpConfigVersion: () => set((s) => ({ configVersion: s.configVersion + 1 })),
  setRegressionInsights: (insights) => set({ regressionInsights: insights }),
  setMacroState: (s) => set((prev) => ({ macroState: prev.macroState ? { ...prev.macroState, ...s } : s })),
  setDaemonWaitingForStart: (v) => set({ daemonWaitingForStart: v }),
}));
