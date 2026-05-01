/**
 * echoforge_worker.js — Web Worker 3
 *
 * Responsibilities:
 *   - Maintain local EchoForge pattern memory (Bayesian aliveness decay)
 *   - Apply peer SharedEcho gossip (30% weight merge)
 *   - Cross-node aliveness validation ("contested" blocks execution)
 *   - Gate execution intents by regime_tag match + minimum aliveness threshold
 *   - Paper-trade heartbeat: hibernating echoes simulate trades in background;
 *     resurrect autonomously when shadow_aliveness clears MIN_ALIVENESS
 *   - Metabolic strain gossip: degradation signals propagate to mesh peers;
 *     quorum of strain reports triggers deterministic global veto ("dead" state)
 *
 * Echo lifecycle:
 *   active ──(losses / aliveness < MIN)──▶ hibernating ──(quorum strain)──▶ dead
 *   hibernating ──(shadow ≥ MIN + conditions clear)──▶ active  (resurrection)
 *   dead: terminal until explicit PHIC un-veto
 *
 * Messages IN:
 *   {type:"init",              phic}
 *   {type:"phic_update",       config}
 *   {type:"signal_pass",       pattern_id, net_alpha, direction, regime_tag}
 *   {type:"execution_result",  pattern_id, outcome_score, regime_tag}
 *   {type:"peer_echo",         pattern_id, net_aliveness, regime_tag, decay_rate, node_id}
 *   {type:"metabolic_strain",  pattern_id, regime_tag, strain_score, node_id}
 *   {type:"regime_change",     regime_tag}
 *   {type:"price_tick",        price}
 *   {type:"latency_report",    exchange_latency_ms}
 *   {type:"execution_stats",   success_rate}
 *   {type:"broadcast_state"}
 *
 * Messages OUT:
 *   {type:"execution_intent",  pattern_id, net_aliveness, regime_tag, net_alpha, direction}
 *   {type:"echo_gossip",       pattern_id, net_aliveness, regime_tag, decay_rate, ...}
 *   {type:"metabolic_strain",  pattern_id, regime_tag, strain_score}
 *   {type:"pattern_veto",      pattern_id, regime_tag, cause, peer_count}
 *   {type:"echo_snapshot",     echoes: [...]}
 *   {type:"contested_alert",   pattern_id, local_aliveness, peer_avg, delta}
 *   {type:"hurdle_suggestion",  suggestions:[...], split_candidates:[...], log_size, window_hours}
 */

"use strict";

// ── Constants ──────────────────────────────────────────────────────────────
const DEFAULT_DECAY_RATE     = 0.10;
const MIN_ALIVENESS          = 0.30;
const LOSS_DECAY_MULTIPLIER  = 7.0;
const SIGNAL_BOOST           = 0.03;
const GOSSIP_INTERVAL_MS     = 5_000;
const SNAPSHOT_INTERVAL_MS   = 2_000;

const CONTEST_THRESHOLD      = 0.30;
const CONTEST_MIN_PEERS      = 2;
const CONTEST_MIN_ALIVENESS  = 0.70;
const PEER_REPORT_TTL_MS     = 30_000;

// Paper-heartbeat
const PAPER_LOOKBACK_MS      = 15_000;  // resolve ghost trade N seconds after entry
const PAPER_SHADOW_ALPHA     = 0.05;    // gentler than real fill (no 7× loss multiplier)
const PAPER_MAX_QUEUE        = 20;      // cap ghost trades per echo
const GHOST_RESOLVE_MS       = 5_000;  // resolution check cadence

// Metabolic strain / quorum veto
const QUORUM_STRAIN_N        = 3;       // peer count that triggers global veto
const STRAIN_TTL_MS          = 60_000;
const STRAIN_LOSS_THRESHOLD  = -0.3;   // outcome_score at which we emit strain

// Pain map (federated peer pain signals)
const PAIN_MAP_TTL_MS        = 60_000;  // same TTL as strain reports
const PAIN_MAP_QUORUM_N      = 3;       // peers reporting pain → escalate to veto
const PAIN_MAP_PENALTY       = 0.05;    // preemptive aliveness penalty per pain report

// ── 24h metabolic signal outcome log ──────────────────────────────────────
const SIGNAL_LOG_TTL_MS      = 24 * 60 * 60 * 1000;  // 24 hours
const SIGNAL_LOG_MAX         = 2000;   // cap to avoid unbounded memory
const SUGGEST_MIN_BUCKET     = 10;     // minimum outcomes per bucket before suggesting
const SUGGEST_INTERVAL_MS    = 60 * 60 * 1000;  // re-analyse every hour
const SUGGEST_EVERY_N        = 25;     // or every N new resolved outcomes

// Strategy type map — mirrors nociceptor_worker.js STRATEGY_TYPE
const _STRATEGY_TYPE = {
  MOMENTUM_V1:         "momentum",
  DEPTH_GRAB:          "momentum",
  SUPERTREND_CROSS:    "momentum",
  WHALE_WAKE:          "momentum",
  ARBI_CROSS_EXCHANGE: "arb",
  REVERSION_A:         "mean_reversion",
  SPREAD_FADE:         "mean_reversion",
};

// Pending signals: pattern_id:regime_tag → [{hurdle, net_alpha, vpin, direction, timestamp}]
// Matched to execution_result by pattern+regime, oldest-first
const _pendingSignals = new Map();

// Resolved 24h log: [{pattern_id, regime_tag, strategy_type, hurdle, net_alpha,
//                     vpin, direction, outcome_score, timestamp}]
const _signalLog = [];

let _resolvedSinceLastSuggest = 0;
let _lastSuggestAt            = 0;

// ── Module state ───────────────────────────────────────────────────────────
let _phic = {
  autonomy_level: 0.5,
  vetoed_patterns: [],
  regime_caps: {},
  emergency_freeze: false,
};
let _currentRegime = "LowVol";
let _currentPrice  = null;   // null until first price_tick — avoids stale 42000 seed
let _currentSpread = null;   // null until first tick from orderbook (used for ghost trade hurdle)
let _exchangeLatencyMs    = null;   // null until first real latency report
let _executionSuccessRate = 1.0;

// Position context — updated from main thread on every portfolio_update
let _position = { btc: 0, avg_cost: 0, unrealized_pnl: 0, total_value: 10000 };

// Drawdown enforcement — high-water mark + hysteresis counter
let _maxPortfolioValue  = 10_000;
let _drawdownBreachCount = 0;

// Asymmetric gating thresholds
const POS_PROFIT_TAKE_THRESHOLD = 0.015;  // >+1.5% unrealized → aggressively exit
const POS_LOSS_SUPPRESS_THRESHOLD = -0.008; // <-0.8% unrealized → suppress new buys

const _echoes = new Map();  // key → echo object

// ── Message router ─────────────────────────────────────────────────────────
self.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init":
      _phic = msg.phic || _phic;
      _startTimers();
      break;
    case "phic_update": {
      const prevDecayRate = _phic.decay_rate;
      _phic = { ..._phic, ...(msg.config || {}) };
      // Propagate new decay_rate to all living echoes so in-flight sessions adapt immediately
      if (msg.config?.decay_rate != null && msg.config.decay_rate !== prevDecayRate) {
        for (const echo of _echoes.values()) {
          if (echo.state !== "dead") echo.decay_rate = _phic.decay_rate;
        }
      }
      break;
    }
    case "regime_change":
      _currentRegime = msg.regime_tag || _currentRegime;
      break;
    case "price_tick":
      if (msg.price > 0) _currentPrice = msg.price;
      if (msg.spread > 0) {
        // Rolling EWMA of bid-ask spread (proxy for round-trip cost)
        _currentSpread = _currentSpread === null
          ? msg.spread
          : _currentSpread * 0.95 + msg.spread * 0.05;
      }
      break;
    case "signal_pass":
      _onSignalPass(msg);
      break;
    case "execution_result":
      _onExecutionResult(msg.pattern_id, msg.outcome_score, msg.regime_tag);
      break;
    case "peer_echo":
      _mergePeerEcho(msg);
      break;
    case "metabolic_strain":
      _handleMetabolicStrain(msg);
      break;
    case "pain_map":
      _handlePainMap(msg);
      break;
    case "broadcast_state":
      _broadcastFullState();
      break;
    case "latency_report":
      _exchangeLatencyMs = _exchangeLatencyMs === null
        ? msg.exchange_latency_ms
        : _exchangeLatencyMs * 0.9 + msg.exchange_latency_ms * 0.1;
      break;
    case "execution_stats":
      _executionSuccessRate = msg.success_rate ?? _executionSuccessRate;
      break;
    case "position_update":
      _position = {
        btc:            msg.btc            ?? _position.btc,
        avg_cost:       msg.avg_cost       ?? _position.avg_cost,
        unrealized_pnl: msg.unrealized_pnl ?? _position.unrealized_pnl,
        total_value:    msg.total_value    ?? _position.total_value,
      };
      // Drawdown enforcement: track high-water mark, freeze after N consecutive breaches
      if (_position.total_value > 0) {
        if (_position.total_value > _maxPortfolioValue) {
          _maxPortfolioValue   = _position.total_value;
          _drawdownBreachCount = 0;
        }
        const drawdownPct = (_maxPortfolioValue - _position.total_value) / _maxPortfolioValue * 100;
        const limit       = _phic.max_drawdown_pct ?? 5;
        if (drawdownPct >= limit) {
          _drawdownBreachCount++;
          const N = _phic.drawdown_hysteresis_n ?? 3;
          if (_drawdownBreachCount >= N && !_phic.emergency_freeze) {
            _phic.emergency_freeze = true;
            self.postMessage({ type: "sentinel_alert", sentinel_type: "Nociceptor",
              action: "drawdown_freeze", severity: 1.0,
              detail: `Drawdown ${drawdownPct.toFixed(1)}% ≥ limit ${limit}% for ${N} samples — auto-freeze`,
              timestamp: Date.now() });
          }
        } else {
          _drawdownBreachCount = 0;
        }
      }
      break;
    case "cross_pair_signal":
      _onCrossPairSignal(msg);
      break;
  }
};

// ── Cross-pair correlation intelligence ────────────────────────────────────
// Boosts mean-reversion echoes on correlation breakdown (pearson < 0.5) and
// momentum echoes when base pair is abnormally volatile with synchronized flow.
const CROSS_PAIR_BOOST = 0.04;

function _stratType(patternId) {
  return (patternId === "REVERSION_A" || patternId === "SPREAD_FADE")
    ? "mean_reversion" : "momentum";
}

function _onCrossPairSignal({ pearson, rvr, flow_sync }) {
  if (_phic.correlation_enabled === false) return;
  const pearsonThreshold = _phic.pearson_threshold ?? 0.5;
  const rvrThreshold     = _phic.rvr_threshold     ?? 1.5;
  const boost            = _phic.cross_pair_boost   ?? CROSS_PAIR_BOOST;
  for (const echo of _echoes.values()) {
    if (echo.state === "dead") continue;
    // Cross-pair intelligence is regime-scoped — don't boost stale echoes from other regimes
    if (echo.regime_tag !== _currentRegime && echo.regime_tag !== "Any") continue;
    const type = _stratType(echo.pattern_id);
    if (type === "mean_reversion" && pearson < pearsonThreshold) {
      echo.net_aliveness = Math.min(1, echo.net_aliveness + boost * (pearsonThreshold - pearson) * 2);
      echo.last_updated  = Date.now();
    } else if (type === "momentum" && rvr > rvrThreshold && flow_sync) {
      echo.net_aliveness = Math.min(1, echo.net_aliveness + boost * Math.min((rvr - rvrThreshold) / rvrThreshold, 1));
      echo.last_updated  = Date.now();
    }
  }
}

// ── Echo key + factory ─────────────────────────────────────────────────────
function _echoKey(patternId, regimeTag) {
  return `${patternId}:${regimeTag || "LowVol"}`;
}

function _getOrCreate(patternId, regimeTag = "LowVol") {
  const regime = regimeTag || "LowVol";
  const key    = _echoKey(patternId, regime);
  if (!_echoes.has(key)) {
    _echoes.set(key, {
      pattern_id:       patternId,
      regime_tag:       regime,
      net_aliveness:    0.0,
      shadow_aliveness: 0.0,   // paper-heartbeat: independent Bayesian tracker
      decay_rate:       _phic.decay_rate ?? DEFAULT_DECAY_RATE,
      execution_count:  0,
      last_updated:     Date.now(),
      // Lifecycle: "active" | "hibernating" | "dead"
      state:            "active",
      // Paper-heartbeat ghost trade queue
      paper_queue:      [],          // [{direction, entry_price, net_alpha, timestamp}]
      // Cross-node validation
      peer_reports:     new Map(),   // node_id → {aliveness, timestamp}
      contested:        false,
      peer_avg:         null,
      // Metabolic strain tracking (quorum veto)
      strain_reports:   new Map(),   // node_id → {strain_score, timestamp}
      // Pain map: federated peer pain signals (preemptive suppression)
      pain_reports:     new Map(),   // node_id → {hurdle_miss_pct, trigger_vpin, timestamp}
    });
  }
  return _echoes.get(key);
}

// ── Cross-node aliveness validation ────────────────────────────────────────
function _updateContested(echo) {
  const cutoff = Date.now() - PEER_REPORT_TTL_MS;
  for (const [id, rep] of echo.peer_reports) {
    if (rep.timestamp < cutoff) echo.peer_reports.delete(id);
  }
  const reports = [...echo.peer_reports.values()];
  if (reports.length < CONTEST_MIN_PEERS) {
    echo.contested = false;
    echo.peer_avg  = null;
    return;
  }
  const peerAvg = reports.reduce((s, r) => s + r.aliveness, 0) / reports.length;
  const delta   = Math.abs(echo.net_aliveness - peerAvg);
  echo.peer_avg  = +peerAvg.toFixed(4);
  echo.contested = delta > CONTEST_THRESHOLD;
  if (echo.contested) {
    self.postMessage({
      type:            "contested_alert",
      pattern_id:      echo.pattern_id,
      local_aliveness: +echo.net_aliveness.toFixed(4),
      peer_avg:        echo.peer_avg,
      delta:           +delta.toFixed(4),
    });
  }
}

// ── Signal gating ──────────────────────────────────────────────────────────
function _onSignalPass(msg) {
  const { pattern_id, net_alpha, direction, regime_tag, hurdle, vpin } = msg;

  // Record to pending log — matched to outcome when execution_result arrives
  const pKey    = pattern_id + ":" + (regime_tag || "LowVol");
  const pending = _pendingSignals.get(pKey) || [];
  pending.push({ hurdle: hurdle || 0, net_alpha, vpin: vpin || 0, direction: direction || "buy", timestamp: Date.now() });
  if (pending.length > 10) pending.shift();  // cap per-pattern pending queue
  _pendingSignals.set(pKey, pending);
  const echo = _getOrCreate(pattern_id, regime_tag);

  // Dead echoes are terminal — no execution, no paper-trading
  if (echo.state === "dead") return;
  if (echo.regime_tag !== _currentRegime && echo.regime_tag !== "Any") return;
  if (_phic.vetoed_patterns?.includes(pattern_id)) return;
  if (_phic.emergency_freeze) return;

  echo.net_aliveness = Math.min(1, echo.net_aliveness + SIGNAL_BOOST);
  echo.last_updated  = Date.now();

  const minAlive = echo.contested ? CONTEST_MIN_ALIVENESS : MIN_ALIVENESS;

  if (echo.net_aliveness < minAlive) {
    // Below execution threshold → record ghost trade; mark hibernating
    if (echo.state !== "dead") echo.state = "hibernating";
    _recordGhostTrade(echo, direction || "buy", net_alpha);
    return;
  }

  // Recovered from hibernation
  if (echo.state === "hibernating") {
    echo.state            = "active";
    echo.shadow_aliveness = 0;
    echo.paper_queue      = [];
  }

  // ── Asymmetric position-aware exit/entry gating ──────────────────────────
  const totalVal   = _position.total_value > 0 ? _position.total_value : 10000;
  const unrealNorm = _position.unrealized_pnl / totalVal;
  const isLong     = _position.btc > 0.0001;
  const resolvedDir = direction || "buy";

  if (isLong) {
    if (unrealNorm > POS_PROFIT_TAKE_THRESHOLD && resolvedDir === "buy") {
      // Sitting on a healthy gain — suppress adding more; flip bias toward sell
      _recordGhostTrade(echo, "sell", net_alpha);
      return;
    }
    if (unrealNorm < POS_LOSS_SUPPRESS_THRESHOLD && resolvedDir === "buy") {
      // Already underwater — stop digging; wait for conditions to clear
      return;
    }
  }

  self.postMessage({
    type:          "execution_intent",
    pattern_id,
    net_aliveness: +echo.net_aliveness.toFixed(4),
    regime_tag:    echo.regime_tag,
    net_alpha:     +net_alpha.toFixed(6),
    direction:     resolvedDir,
    contested:     echo.contested,
    // Pass position context so execution_worker can also react
    unrealized_pnl_norm: +unrealNorm.toFixed(6),
    timestamp:     Date.now(),
  });
}

// ── Paper-heartbeat ────────────────────────────────────────────────────────
function _recordGhostTrade(echo, direction, net_alpha) {
  if (echo.paper_queue.length >= PAPER_MAX_QUEUE) echo.paper_queue.shift();
  echo.paper_queue.push({
    direction,
    entry_price: _currentPrice,
    net_alpha,
    timestamp:   Date.now(),
  });
}

function _resolveGhostTrades() {
  const now    = Date.now();
  const cutoff = now - PAPER_LOOKBACK_MS;

  for (const echo of _echoes.values()) {
    if (echo.state === "dead" || echo.paper_queue.length === 0) continue;

    const remaining = [];
    for (const trade of echo.paper_queue) {
      if (trade.timestamp > cutoff) { remaining.push(trade); continue; }

      // Did price move in the predicted direction by more than round-trip cost?
      // Use rolling spread as hurdle; fallback to 0.02% if spread not yet seeded.
      const entryPx   = trade.entry_price || _currentPrice || 1;
      const priceDiff = ((_currentPrice ?? entryPx) - entryPx) / entryPx;
      const spreadPct = _currentSpread !== null && entryPx > 0
        ? _currentSpread / entryPx
        : 0.0002;
      const win       = trade.direction === "buy"
        ? priceDiff >  spreadPct
        : priceDiff < -spreadPct;

      echo.shadow_aliveness = Math.max(0, Math.min(1,
        echo.shadow_aliveness * (1 - PAPER_SHADOW_ALPHA) +
        (win ? 1.0 : 0.0) * PAPER_SHADOW_ALPHA
      ));
    }
    echo.paper_queue = remaining;

    // Autonomous resurrection: shadow cleared the hurdle + blocking conditions lifted
    if (echo.state === "hibernating" && echo.shadow_aliveness >= MIN_ALIVENESS) {
      const vetoActive  = _phic.vetoed_patterns?.includes(echo.pattern_id);
      const regimeMatch = echo.regime_tag === _currentRegime || echo.regime_tag === "Any";
      if (!vetoActive && regimeMatch && !_phic.emergency_freeze) {
        echo.net_aliveness    = Math.max(echo.net_aliveness, echo.shadow_aliveness * 0.7);
        echo.state            = "active";
        echo.shadow_aliveness = 0;
        echo.paper_queue      = [];
        console.info(`[echoforge] RESURRECTED ${echo.pattern_id}:${echo.regime_tag}`);
      }
    }
  }
}

// ── Bayesian decay + strain emission ───────────────────────────────────────
function _onExecutionResult(patternId, outcomeScore, regimeTag) {
  const preferredKey = regimeTag ? _echoKey(patternId, regimeTag) : null;
  const echo = (preferredKey && _echoes.get(preferredKey))
    || [..._echoes.values()].find(e => e.pattern_id === patternId);
  if (!echo) return;

  // Resolve oldest matching pending signal into the 24h log
  const pKey   = patternId + ":" + (regimeTag || "LowVol");
  const pending = _pendingSignals.get(pKey);
  if (pending?.length > 0) {
    const sig = pending.shift();
    const entry = {
      pattern_id:    patternId,
      regime_tag:    regimeTag || "LowVol",
      strategy_type: _STRATEGY_TYPE[patternId] ?? "momentum",
      hurdle:        sig.hurdle,
      net_alpha:     sig.net_alpha,
      vpin:          sig.vpin,
      direction:     sig.direction,
      outcome_score: outcomeScore,
      timestamp:     Date.now(),
    };
    _signalLog.push(entry);
    // Evict entries older than 24h and cap total size
    const cutoff = Date.now() - SIGNAL_LOG_TTL_MS;
    while (_signalLog.length > 0 && _signalLog[0].timestamp < cutoff) _signalLog.shift();
    if (_signalLog.length > SIGNAL_LOG_MAX) _signalLog.shift();

    _resolvedSinceLastSuggest++;
    if (_resolvedSinceLastSuggest >= SUGGEST_EVERY_N ||
        Date.now() - _lastSuggestAt >= SUGGEST_INTERVAL_MS) {
      _runSuggestionEngine();
    }
  }

  const normalised     = (outcomeScore + 1.0) / 2.0;
  const lossMultiplier = _phic.loss_multiplier ?? LOSS_DECAY_MULTIPLIER;
  const alpha          = outcomeScore < 0
    ? Math.min(echo.decay_rate * lossMultiplier, 1.0)
    : echo.decay_rate;

  echo.net_aliveness = Math.max(0, Math.min(1,
    echo.net_aliveness * (1 - alpha) + normalised * alpha
  ));
  echo.execution_count++;
  echo.last_updated = Date.now();
  _updateContested(echo);

  // Significant loss below threshold → emit metabolic strain to mesh
  if (outcomeScore <= STRAIN_LOSS_THRESHOLD && echo.net_aliveness < MIN_ALIVENESS) {
    if (echo.state === "active") echo.state = "hibernating";
    const strainScore = Math.min(1, (MIN_ALIVENESS - echo.net_aliveness) / MIN_ALIVENESS);
    self.postMessage({
      type:         "metabolic_strain",
      pattern_id:   echo.pattern_id,
      regime_tag:   echo.regime_tag,
      strain_score: +strainScore.toFixed(4),
    });
  }
}

// ── Metabolic strain (received from mesh peers) ─────────────────────────────
function _handleMetabolicStrain(msg) {
  const { pattern_id, regime_tag, strain_score, node_id } = msg;
  if (!node_id) return;

  const echo   = _getOrCreate(pattern_id, regime_tag);
  if (echo.state === "dead") return;

  const now    = Date.now();
  const cutoff = now - STRAIN_TTL_MS;

  echo.strain_reports.set(node_id, { strain_score, timestamp: now });
  for (const [id, rep] of echo.strain_reports) {
    if (rep.timestamp < cutoff) echo.strain_reports.delete(id);
  }

  if (echo.strain_reports.size >= QUORUM_STRAIN_N) {
    _applyQuorumVeto(echo);
  }
}

// Stress hierarchy for cascade veto: failure in a high-stress regime implies
// the pattern is also unreliable in intermediate regimes.
// Crisis → HighVol (but not LowVol — calm conditions are a different beast).
const VETO_CASCADE = {
  Crisis:  ["HighVol"],
  HighVol: [],
  LowVol:  [],
};

function _applyQuorumVeto(echo) {
  const peerCount = echo.strain_reports.size;
  _killEcho(echo, peerCount, "quorum_strain");

  for (const cascadeRegime of (VETO_CASCADE[echo.regime_tag] || [])) {
    const cascadeEcho = _echoes.get(_echoKey(echo.pattern_id, cascadeRegime));
    if (cascadeEcho && cascadeEcho.state !== "dead") {
      _killEcho(cascadeEcho, peerCount, `cascade_from_${echo.regime_tag}`);
    }
  }
}

function _killEcho(echo, peerCount, cause) {
  echo.state            = "dead";
  echo.net_aliveness    = 0;
  echo.shadow_aliveness = 0;
  echo.paper_queue      = [];
  echo.last_updated     = Date.now();
  console.warn(`[echoforge] VETO ${echo.pattern_id}:${echo.regime_tag} cause=${cause}`);
  self.postMessage({
    type:       "pattern_veto",
    pattern_id: echo.pattern_id,
    regime_tag: echo.regime_tag,
    cause,
    peer_count: peerCount,
  });
}

// ── Pain map (federated peer pain signals) ─────────────────────────────────
function _handlePainMap(msg) {
  const { pattern_id, regime_tag, node_id, hurdle_miss_pct, trigger_vpin, timestamp } = msg;
  if (!node_id) return;

  const echo = _getOrCreate(pattern_id, regime_tag);
  if (echo.state === "dead") return;

  const now    = Date.now();
  const cutoff = now - PAIN_MAP_TTL_MS;

  // Expire stale reports
  for (const [id, rep] of echo.pain_reports) {
    if (rep.timestamp < cutoff) echo.pain_reports.delete(id);
  }

  echo.pain_reports.set(node_id, { hurdle_miss_pct, trigger_vpin, timestamp: now });

  // Preemptive aliveness penalty scaled by how far below the hurdle the peer was
  const penalty = PAIN_MAP_PENALTY * Math.min(1, hurdle_miss_pct);
  echo.net_aliveness = Math.max(0, echo.net_aliveness * (1 - penalty));
  echo.last_updated  = now;

  // Quorum: 3+ peers with high-VPIN pain → escalate to veto (same as strain quorum)
  const highVpinPain = [...echo.pain_reports.values()].filter(r => r.trigger_vpin >= 0.50);
  if (highVpinPain.length >= PAIN_MAP_QUORUM_N) {
    console.warn(
      `[echoforge] PAIN_QUORUM ${pattern_id}:${regime_tag} — ${highVpinPain.length} peers in pain`
    );
    _killEcho(echo, highVpinPain.length, "pain_map_quorum");
  }
}

// ── Peer echo merge ─────────────────────────────────────────────────────────
function _mergePeerEcho(msg) {
  const { pattern_id, net_aliveness, regime_tag, decay_rate, node_id } = msg;
  const echo = _getOrCreate(pattern_id, regime_tag);
  if (echo.state === "dead") return;

  if (node_id) {
    echo.peer_reports.set(node_id, { aliveness: net_aliveness, timestamp: Date.now() });
  }
  const localWeight  = Math.max(0.3, Math.min(0.7, echo.net_aliveness * 2));
  echo.net_aliveness = echo.net_aliveness * localWeight + net_aliveness * (1 - localWeight);
  echo.decay_rate    = echo.decay_rate    * 0.8 + decay_rate * 0.2;
  echo.regime_tag    = regime_tag;
  echo.last_updated  = Date.now();
  _updateContested(echo);
}

// ── State broadcast (warm-start joining peers) ─────────────────────────────
function _broadcastFullState() {
  const now = Date.now();
  for (const echo of _echoes.values()) {
    if (echo.state === "dead") continue;
    if (echo.net_aliveness < MIN_ALIVENESS) continue;
    self.postMessage({
      type:            "echo_gossip",
      pattern_id:      echo.pattern_id,
      net_aliveness:   +echo.net_aliveness.toFixed(4),
      decay_rate:      +echo.decay_rate.toFixed(4),
      regime_tag:      echo.regime_tag,
      execution_count: echo.execution_count,
      timestamp:       now,
    });
  }
}

// ── Metabolic auto-suggest engine ─────────────────────────────────────────
// Analyses the rolling 24h signal log. Groups outcomes by regime × strategy_type.
// Detects two things:
//   1. Hurdle miscalibration — win rate consistently too low (raise strain) or
//      too high with large margin (ease strain → missing good trades)
//   2. Regime split candidates — within a regime, outcomes split cleanly by
//      direction (bullish vs bearish) or by VPIN band, suggesting the regime
//      label is too coarse and should be split.
//
// Emits {type:"hurdle_suggestion"} to the main thread when actionable.
function _runSuggestionEngine() {
  _lastSuggestAt            = Date.now();
  _resolvedSinceLastSuggest = 0;

  if (_signalLog.length < SUGGEST_MIN_BUCKET) return;

  // ── Build buckets: regime × strategy_type ─────────────────────────────
  const buckets = new Map();
  for (const e of _signalLog) {
    const key = e.regime_tag + ":" + e.strategy_type;
    const b   = buckets.get(key) || { regime_tag: e.regime_tag, strategy_type: e.strategy_type, entries: [] };
    b.entries.push(e);
    buckets.set(key, b);
  }

  const suggestions     = [];
  const split_candidates = [];

  for (const b of buckets.values()) {
    if (b.entries.length < SUGGEST_MIN_BUCKET) continue;

    const n        = b.entries.length;
    const wins     = b.entries.filter(e => e.outcome_score > 0).length;
    const win_rate = wins / n;
    const avgMargin = b.entries.reduce((s, e) => s + (e.net_alpha - e.hurdle), 0) / n;
    const avgHurdle = b.entries.reduce((s, e) => s + e.hurdle, 0) / n;

    // Current strain for this regime (from PHIC or hardcoded default)
    const defaults = { LowVol: 0.0, HighVol: 0.5, Crisis: 1.5 };
    const currentStrain = _phic.regime_strain_exp?.[b.regime_tag]
      ?? defaults[b.regime_tag] ?? 0;

    // Hurdle too easy — losing too often, raise strain
    if (win_rate < 0.40 && n >= SUGGEST_MIN_BUCKET) {
      suggestions.push({
        regime_tag:       b.regime_tag,
        strategy_type:    b.strategy_type,
        action:           "raise_strain",
        current_strain:   +currentStrain.toFixed(2),
        suggested_strain: +Math.min(currentStrain + 0.15, 3.0).toFixed(2),
        win_rate_pct:     +(win_rate * 100).toFixed(1),
        n,
        basis: `${(win_rate * 100).toFixed(0)}% win on ${n} trades — hurdle too permissive`,
      });
    }
    // Hurdle too tight — winning with large margin, ease strain to catch marginal-but-good signals
    else if (win_rate > 0.65 && avgHurdle > 0 && avgMargin > avgHurdle * 0.5 && n >= SUGGEST_MIN_BUCKET) {
      suggestions.push({
        regime_tag:       b.regime_tag,
        strategy_type:    b.strategy_type,
        action:           "ease_strain",
        current_strain:   +currentStrain.toFixed(2),
        suggested_strain: +Math.max(currentStrain - 0.10, 0).toFixed(2),
        win_rate_pct:     +(win_rate * 100).toFixed(1),
        n,
        basis: `${(win_rate * 100).toFixed(0)}% win, avg margin ${(avgMargin / avgHurdle * 100).toFixed(0)}% above hurdle — may be missing good trades`,
      });
    }

    // ── Sub-regime split detection: split by direction (bullish vs bearish) ──
    // If outcomes differ by >20pp between buy-direction and sell-direction signals
    // within the same regime, the regime label is too coarse.
    const buyEntries  = b.entries.filter(e => e.direction === "buy");
    const sellEntries = b.entries.filter(e => e.direction === "sell");
    if (buyEntries.length >= 6 && sellEntries.length >= 6) {
      const buyWR  = buyEntries.filter(e => e.outcome_score > 0).length / buyEntries.length;
      const sellWR = sellEntries.filter(e => e.outcome_score > 0).length / sellEntries.length;
      if (Math.abs(buyWR - sellWR) > 0.20) {
        split_candidates.push({
          regime_tag:    b.regime_tag,
          strategy_type: b.strategy_type,
          dimension:     "direction",
          sub_a:         { label: "bullish", win_rate: +buyWR.toFixed(3),  n: buyEntries.length },
          sub_b:         { label: "bearish", win_rate: +sellWR.toFixed(3), n: sellEntries.length },
          basis: `Buy-side win=${(buyWR*100).toFixed(0)}% vs sell-side win=${(sellWR*100).toFixed(0)}% — ${b.regime_tag} behaves differently by flow direction`,
        });
      }
    }

    // ── Sub-regime split detection: split by VPIN band (low vs high within regime) ──
    const vpinMid     = b.entries.reduce((s, e) => s + e.vpin, 0) / n;
    const lowVpinE    = b.entries.filter(e => e.vpin < vpinMid);
    const highVpinE   = b.entries.filter(e => e.vpin >= vpinMid);
    if (lowVpinE.length >= 6 && highVpinE.length >= 6) {
      const lowWR  = lowVpinE.filter(e => e.outcome_score > 0).length / lowVpinE.length;
      const highWR = highVpinE.filter(e => e.outcome_score > 0).length / highVpinE.length;
      if (Math.abs(lowWR - highWR) > 0.20) {
        split_candidates.push({
          regime_tag:    b.regime_tag,
          strategy_type: b.strategy_type,
          dimension:     "vpin_band",
          sub_a:         { label: `VPIN<${vpinMid.toFixed(2)}`, win_rate: +lowWR.toFixed(3),  n: lowVpinE.length },
          sub_b:         { label: `VPIN≥${vpinMid.toFixed(2)}`, win_rate: +highWR.toFixed(3), n: highVpinE.length },
          basis: `Within ${b.regime_tag}, low-VPIN win=${(lowWR*100).toFixed(0)}% vs high-VPIN win=${(highWR*100).toFixed(0)}% — VPIN band matters`,
        });
      }
    }
  }

  if (suggestions.length === 0 && split_candidates.length === 0) return;

  self.postMessage({
    type:             "hurdle_suggestion",
    suggestions,
    split_candidates,
    log_size:         _signalLog.length,
    window_hours:     +((_signalLog[_signalLog.length - 1]?.timestamp - _signalLog[0]?.timestamp) / 3_600_000).toFixed(1),
    timestamp:        Date.now(),
  });
}

// ── Timers ─────────────────────────────────────────────────────────────────
function _startTimers() {
  // Gossip active echoes to peers
  setInterval(() => {
    const now = Date.now();
    for (const echo of _echoes.values()) {
      if (echo.state === "dead") continue;
      if (echo.net_aliveness < MIN_ALIVENESS) continue;
      self.postMessage({
        type:                   "echo_gossip",
        pattern_id:             echo.pattern_id,
        net_aliveness:          +echo.net_aliveness.toFixed(4),
        regime_tag:             echo.regime_tag,
        decay_rate:             echo.decay_rate,
        exchange_latency_ms:    +(_exchangeLatencyMs ?? 0).toFixed(2),
        execution_success_rate: +_executionSuccessRate.toFixed(4),
        timestamp:              now,
      });
    }
  }, GOSSIP_INTERVAL_MS);

  // UI snapshot
  setInterval(() => {
    self.postMessage({
      type:   "echo_snapshot",
      echoes: [..._echoes.values()].map(e => ({
        pattern_id:       e.pattern_id,
        regime_tag:       e.regime_tag,
        net_aliveness:    +e.net_aliveness.toFixed(4),
        shadow_aliveness: +e.shadow_aliveness.toFixed(4),
        decay_rate:       e.decay_rate,
        execution_count:  e.execution_count,
        last_updated:     e.last_updated,
        state:            e.state,
        contested:        e.contested,
        peer_avg:         e.peer_avg,
        peer_count:       e.peer_reports.size,
        strain_count:     e.strain_reports.size,
        paper_depth:      e.paper_queue.length,
      })),
    });
  }, SNAPSHOT_INTERVAL_MS);

  // Paper-heartbeat resolution
  setInterval(_resolveGhostTrades, GHOST_RESOLVE_MS);
}
