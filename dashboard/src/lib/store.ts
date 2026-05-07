"use client";

import { create } from "zustand";

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
  // Phase 7 governance
  max_pattern_exposure_pct: number;   // cap any single pattern at N% of portfolio (0 = off)
  max_total_exposure_pct:   number;   // hard cap on aggregate BTC position across all patterns (default 0.20)
  drawdown_hysteresis_n:   number;   // consecutive breaches before auto-freeze (default 3)
  correlation_enabled:     boolean;  // toggle cross-pair signal processing
  rvr_threshold:           number;   // RVR > this → HighVol momentum boost (default 1.5)
  pearson_threshold:       number;   // Pearson < this → mean-reversion boost (default 0.5)
  cross_pair_boost:        number;   // aliveness boost magnitude per cross-pair signal (default 0.04)
  stop_loss_pct:           number;   // sell 50% of position when price drops this % below avg_cost (0 = off, default 2.5)
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
}

const DEFAULT_METRICS: NodeMetrics = {
  vpin: 0, toxic: false,
  exchange_latency_ms: 0, is_passive: false,
  peers: 0, connected: false,
  sovereign_node_id: "—", is_sovereign: true, s_ex: 0,
  saf_pending: 0, success_rate: 1.0, is_rate_limited: false,
};

const DEFAULT_PHIC: PHICConfig = {
  autonomy_level:           0.5,
  vetoed_patterns:          [],
  regime_caps:              { LowVol: 1.0, HighVol: 0.5, Crisis: 0.1 },
  emergency_freeze:         false,
  max_position_pct:         1.0,
  min_consensus_pct:        0.5,
  max_drawdown_pct:         5.0,
  execution_disabled:       false,
  max_pattern_exposure_pct: 0.30,
  max_total_exposure_pct:   0.20,
  drawdown_hysteresis_n:    3,
  correlation_enabled:      true,
  rvr_threshold:            1.5,
  pearson_threshold:        0.5,
  cross_pair_boost:         0.04,
  stop_loss_pct:            2.5,
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
}));
