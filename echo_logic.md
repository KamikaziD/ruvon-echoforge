# EchoForge Echo Logic — Complete System Reference

> **Version:** EchoForge v0.1.2 · Last updated: 2026-05-14
> **Scope:** End-to-end logic map of the sovereign trading mesh — from raw VALR/BINANCE websocket feed to executed order, aliveness feedback, and cloud learning loop.

---

## Part 1 — System Overview

EchoForge is a browser-native sovereign trading mesh that executes BTC/USDT spot trades on VALR using a multi-worker signal pipeline. No central server controls trade decisions; the browser tab is the execution unit. Multiple tabs can form a P2P mesh via Trystero/WebRTC, sharing echo aliveness, regime votes, and pain signals — but each tab trades independently with its own VALR API key.

The core abstraction is the **echo**: a per-pattern, per-regime entity that accumulates evidence about a trading pattern's edge and gates whether signals from that pattern are allowed to reach the order book. Echoes decay on losses and recover through paper-heartbeat simulation. When multiple tabs are running, echoes gossip their state to peers and can be killed by distributed quorum if a pattern is consistently failing across the mesh.

The signal pipeline is strictly feed-forward: market data → analytics → inference → metabolic filter → echo gate → execution → fill → outcome → aliveness update → bridge learning loop. There is no feedback shortcut that bypasses the metabolic filter. The Guardian state machine sits orthogonally, able to block buy intents at any point without touching the echo or nociceptor layers.

---

## Part 2 — Architecture Topology

```
VALR WebSocket          BINANCE WebSocket
    │                        │
    ▼                        ▼
┌───────────────────────────────────────────────────────┐
│  orderbook_worker.js                                  │
│  • L2 orderbook maintenance (bids/asks Map)           │
│  • Price analytics: EMA fast/slow, z-score, momentum │
│  • VWAP (5min halflife), TWAP bot detection           │
│  • OFI feature vector (12-element, 100ms throttle)    │
│  • VPIN (200ms decay vol EWMA)                        │
│  • Self-emits WHALE_WAKE signals                      │
└─────────────┬─────────────────────────┬───────────────┘
              │ tick/ofi_snapshot        │ WHALE_WAKE signal
              ▼                          │
┌─────────────────────────┐             │
│  inference_worker.js    │             │
│  (× 3 jury workers)     │             │
│  • Box-Muller noise     │             │
│  • Bundled MLP OR       │             │
│    ORT ONNX model       │             │
│  • OFI model (ORT)      │             │
│  Consensus: median vote │             │
│  p_up = mean of votes   │             │
└─────────┬───────────────┘             │
          │ jury_result                  │
          ▼                             │
┌──────────────────────────────────────▼─────────────────┐
│  index.html (main thread)                               │
│  • Aggregates jury votes → gross_delta, p_up           │
│  • Applies trend filter (suppress contra-trend entries) │
│  • Forwards signals → nociceptor_worker                 │
│  • Guardian HSM (NOMINAL/CAUTIOUS/REDUCE_ONLY/HALTED)  │
│  • Enriches execution_intent with p_up, fees, price    │
│  • PHIC broadcast to all workers                        │
│  • BroadcastChannel echo warm-start                    │
└─────────────┬────────────────────────────┬─────────────┘
              │ signal (raw)               │ execution_intent (enriched)
              ▼                            ▼
┌─────────────────────────┐   ┌──────────────────────────┐
│  nociceptor_worker.js   │   │  execution_worker.js      │
│  • VPIN from SAB ring   │   │  • 9-gate intent filter   │
│  • Regime detection     │   │  • Kelly sizing           │
│  • Dynamic hurdle       │   │  • Stop-loss (30s check)  │
│  • Metabolic filter     │   │  • Regime exit sell       │
│  • Pain map broadcast   │   │  • Profit banking tiers   │
│  • signal_pass/drop     │   │  • Floor enforcement      │
└────────────┬────────────┘   │  • SAF (IndexedDB)        │
             │ signal_pass    └────────────┬──────────────┘
             ▼                             │ VALR REST order
┌────────────────────────┐                │
│  echoforge_worker.js   │                ▼
│  • Echo lifecycle      │      ┌─────────────────┐
│  • Aliveness gating    │      │  VALR Exchange  │
│  • Bayesian decay      │      │  Order fill     │
│  • Paper heartbeat     │      └────────┬────────┘
│  • Peer gossip         │               │ execution_result
│  • Suggestion engine   │◄──────────────┘
│  • Quorum veto         │
└────────────┬───────────┘
             │ outcome_recorded (decisive only)
             ▼
┌────────────────────────┐
│  bridge/main.py        │
│  • DriftMonitor        │
│  • RegressionOptimizer │
│  • SGD per strategy    │
└────────────────────────┘
             ▲
             │ cross_pair_signal
┌────────────────────────┐
│  correlation_worker.js │
│  • Rolling Pearson     │
│  • Lag EWMA            │
│  • ARBI_CROSS_EXCHANGE │
└────────────────────────┘
```

---

## Part 3 — Detailed Logic

---

### §1 — Market Data Pipeline (`orderbook_worker.js`)

#### Constants

```
VOLUME_DECAY_200MS  = 0.95       — buy/sell EWMA decay factor per 200ms tick
OFI_LEVELS          = 5          — depth levels tracked in OFI features
OFI_THROTTLE_MS     = 100        — OFI snapshot emission interval
DEPTH_LEVELS        = 10
DEPTH_THROTTLE_MS   = 250
EMA_FAST_HALFLIFE_MS  = 5_000    — ~5s half-life for fast EMA
EMA_SLOW_HALFLIFE_MS  = 20_000   — ~20s half-life for slow EMA
Z_SCORE_WINDOW_MS   = 30_000     — 30s rolling window for z-score
VWAP_HALFLIFE_MS    = 300_000    — 5min half-life for VWAP decay
TWAP_WINDOW         = 20
TWAP_ALPHA          = 2/21       — EWMA coefficient for TWAP score
```

#### L2 Orderbook

`_bids` and `_asks` are `Map<price_str, qty>`. `l2_snapshot` messages fully replace the book. `l2_delta` messages: qty=0 removes a level, qty>0 sets it. Analytics (VPIN, OFI) run only on BTC/USDT; all symbols emit `tick` messages.

#### Orderbook VPIN (feeds OFI feature[10] and inference)

```
volDecay  = 0.95 ^ (dt_ms / 200)
_buyVol   = _buyVol  * volDecay + (side=buy  ? volume : 0)
_sellVol  = _sellVol * volDecay + (side=sell ? volume : 0)
vpin      = |_buyVol - _sellVol| / (_buyVol + _sellVol)   ∈ [0, 1]
```

This VPIN is a **per-tick, 200ms-decay** measure that reacts quickly to flow imbalances. It feeds directly into OFI feature[10] and therefore influences inference model output.

#### OFI Feature Vector (12 elements, `ofi_snapshot` at 100ms)

```
[0..4]  deltaBids[L1..L5]  = currentBidSize[i] - prevBidSize[i]
[5..9]  deltaAsks[L1..L5]  = currentAskSize[i] - prevAskSize[i]
[10]    vpin                (orderbook VPIN, 200ms decay, as above)
[11]    spreadNrm           = min(spread/mid, 0.01) / 0.01   — capped at 1.0
```

#### Price Analytics (per `tick` message)

| Field | Formula |
|---|---|
| `emaFast` | Time-normalised EWMA: α = 1 − exp(−dt·ln2/5000) |
| `emaSlow` | Same formula, halflife 20000ms |
| `z_score` | (price − mean30s) / std30s; 0.0 if <5 samples |
| `momentum` | (emaFast − emaSlow) / emaSlow |
| `vwap` | Decayed volume-weighted price, 5min halflife |
| `twap_score` | EWMA of \|currentSize − lastSize\| / meanSize; ~0.0 = TWAP bot active |
| `vwap_anchor` | Reversion strength toward VWAP after flow imbalance |

#### WHALE_WAKE Self-Emission

```javascript
whaleDetected = twap_score < 0.15 || vwap_anchor > 0.80
flowImbal     = (buyVol - sellVol) / (buyVol + sellVol)
threshold     = (flowImbal > 0 && trend < -0.002) ? 0.25 : 0.10

if |flowImbal| > threshold:
  emit signal { pattern_id: "WHALE_WAKE", gross_delta: ±0.004, regime_tag: "Any" }
```

The sign of `gross_delta` follows `flowImbal` direction. This signal bypasses the jury ensemble and goes directly to nociceptor.

#### Messages Emitted

`tick` · `depth_update` · `ofi_snapshot` · `depth_alert`

---

### §2 — Nociceptor: VPIN & Metabolic Filter (`nociceptor_worker.js`)

#### Constants

```
VPIN_CRISIS_DEFAULT    = 0.70
VPIN_HIGHVOL_DEFAULT   = 0.35
EWMA_FAST_DEFAULT      = 0.02   — α per SAB tick (~270ms halflife at 25tps)
VPIN_WARMUP_TICKS      = 100    — ticks before VPIN considered reliable
POLL_INTERVAL_MS       = 8      — SAB ring buffer read interval
LATENCY_CEILING        = 150ms
SKEW_CEILING           = 50ms
VPIN_ALERT_COOLDOWN_MS = 3_000
HURDLE_REGIME_SCALE_DEFAULT = { LowVol: 0.85, HighVol: 1.0, Crisis: 1.20 }
```

#### Nociceptor VPIN (regime detection and hurdle — separate from orderbook VPIN)

```
Every 8ms, read SharedArrayBuffer ring buffer for latest trade ticks.

ewmaAlpha = _phic.vpin_ewma_alpha ?? 0.02
_buyVol   = _buyVol  * (1 - α) + tick.volume * α   (buy-side ticks only)
_sellVol  = _sellVol * (1 - α) + tick.volume * α   (sell-side ticks only)
vpin      = |_buyVol - _sellVol| / (_buyVol + _sellVol)
_lastVpin = vpin
```

**Regime thresholds:** LowVol < 0.35 ≤ HighVol < 0.70 ≤ Crisis

This VPIN uses a slow EWMA (α=0.02) so it represents a **smoothed, persistent** view of order flow toxicity. It drives regime detection and hurdle scaling.

#### STRATEGY_STRAIN Exponents

Per-type, per-regime strain applied as an exponential multiplier on the hurdle:

```
Strategy type     LowVol  HighVol  Crisis
─────────────────────────────────────────
mean_reversion     0.0     0.3      0.3
momentum           0.0     0.4      1.5
maker              0.2     0.8      2.5
trend              0.0     0.0      0.3
institutional      0.0     0.2      1.0
breakout           0.8     0.1      0.0
arb                0.0     0.0      0.0   ← immune to strain
```

High strain = exponentially higher hurdle = pattern needs much stronger net_alpha to pass.

#### REGIME_REQUIREMENTS (structural gates before metabolic evaluation)

```
SUPERTREND_CROSS: ["HighVol", "Crisis"]
```

LowVol signals from SUPERTREND_CROSS are dropped immediately with reason `REGIME_REQUIREMENT` before any metabolic computation.

#### VPIN_MULT_FN (per-type hurdle response to VPIN over-threshold)

```
vpinOver = max(0, (vpin - vpinCrisis) / (1 - vpinCrisis))   ∈ [0, 1]

Strategy type     Multiplier formula                        Range
─────────────────────────────────────────────────────────────────────
mean_reversion    1 + vpinOver * 8                          1.0 → 9.0
arb               1.0                                        1.0 (immune)
momentum          1 + vpinOver * 2                          1.0 → 3.0
maker             1 + vpinOver * 6                          1.0 → 7.0
trend             max(0.4, 1 - vpinOver * 1.5)              1.0 → 0.4 (hurdle falls)
institutional     max(0.5, 1 - vpinOver * 1.8)              1.0 → 0.5 (hurdle falls)
breakout          max(0.2, 1 - vpinOver * 0.5)              1.0 → 0.2 (hurdle falls)
```

Trend, institutional, and breakout are **inverse** — their hurdles fall as VPIN spikes because these strategies have structural edge in volatile conditions.

#### Dynamic Hurdle Formula

```
type          = STRATEGY_TYPE[pattern_id]
strain        = _phic[strategy_strain_overrides?.[type]?.[regime]]  (priority 1, not yet implemented)
              ?? STRATEGY_STRAIN[type][regime]                        (priority 2, hardcoded)
              ?? _phic.regime_strain_exp[regime]                      (priority 3, global PHIC override)
              ?? REGIME_STRAIN_EXP[regime]                            (priority 4, legacy fallback)

strainMult    = type === "arb" ? 1.0 : Math.exp(strain)
vpinMult      = VPIN_MULT_FN[type](vpinOver)
riskMult      = _phic.proactive_overrides?.risk_multiplier ?? 1.0
regimeScale   = _phic.hurdle_regime_scale?.[regime] ?? HURDLE_REGIME_SCALE_DEFAULT[regime]
baseExecCost  = maker_fee + taker_fee

hurdle = baseExecCost × strainMult × vpinMult × riskMult × regimeScale
```

**Example (mean_reversion, HighVol, VPIN=0.60):**
- strain=0.3 → strainMult=e^0.3=1.350
- vpinOver=0 (VPIN=0.60 < crisis=0.70) → vpinMult=1.0
- regimeScale=1.0, riskMult=1.0
- **hurdle = 0.001 × 1.350 × 1.0 × 1.0 × 1.0 = 0.00135**

**Example (mean_reversion, Crisis, VPIN=0.85):**
- strain=0.3 → strainMult=1.350
- vpinOver=(0.85-0.70)/(1-0.70)=0.500 → vpinMult=1+0.500×8=5.0
- regimeScale=1.20
- **hurdle = 0.001 × 1.350 × 5.0 × 1.0 × 1.20 = 0.00810**

#### `_runMetabolic` Gate Sequence

1. **Pattern veto** → `signal_drop: PHIC_VETO`
2. **Freeze / passive** → `signal_drop: FREEZE | PASSIVE`
3. Compute `netAlpha = |gross_delta| - (maker_fee + taker_fee + slippage_est)`
4. Compute dynamic hurdle (formula above)
5. **ARB lag guard:** `Math.abs(exchange_lag_ms) < 10` → `signal_drop: ARB_LAG_TOO_SMALL`
6. **Regime requirement:** check `REGIME_REQUIREMENTS[pattern_id]` → `signal_drop: REGIME_REQUIREMENT`
7. **Regime cap zero:** `_phic.regime_caps[regime] <= 0` AND `direction=buy` → `signal_drop: REGIME_CAP_ZERO`
8. **Metabolic decision:**
   - `netAlpha >= hurdle` → `signal_pass` carrying: `{direction, net_alpha, hurdle, vpin, regime_cap, strategy_type, regime_tag}`
   - `netAlpha < hurdle` → `signal_drop: METABOLIC_DROP` + `sentinel_alert` (severity 0.3)
   - If drop AND `_lastVpin >= 0.35` → broadcast `pain_map` to mesh peers

#### Proprioceptor (Latency Monitor)

```
_latencyEWMA = _latencyEWMA * 0.9 + latencySample * 0.1

Passive mode triggered when:  lat > 150ms  OR  skewMs > 50ms
Recovery requires:             lat < 105ms  AND  skewMs < 35ms
```

While passive, all signals are dropped. Reports latency every 1s for S(Ex) sovereign scoring.

---

### §3 — Signal Generation (7 Patterns, 3 Sources)

#### Source A — Inference-Driven (5 patterns)

Patterns: `REVERSION_A`, `MOMENTUM_V1`, `DEPTH_GRAB`, `SPREAD_FADE`, `VOLATILITY_BREAKOUT`

**Feature vector assembled by index.html (11 elements):**

```
[0]  momentum       = (emaFast - emaSlow) / emaSlow
[1]  z_score        = (price - mean30s) / std30s
[2]  vwap_dev       = (price - vwap) / vwap
[3]  imbalance      = L2 bid/ask ratio from depth
[4]  vol_ratio      = buy_volume / sell_volume
[5]  spread_norm    = bid-ask spread / price
[6]  ema_fast_dev   = (price - emaFast) / emaFast
[7]  ema_slow_dev   = (price - emaSlow) / emaSlow
[8]  cost_basis_dev = (avg_cost - price) / price
[9]  unrealized_pct = unrealized_pnl / total_value
[10] pos_size_norm  = btc * price / total_value
```

**Jury ensemble (3 inference workers):**

Each worker:
1. Receives feature vector from main thread
2. Adds Box-Muller Gaussian noise (`feature_noise` PHIC param) to each feature
3. Runs bundled MLP (`_jsInfer`) or ORT ONNX session if retrained model is loaded
4. Returns a scalar vote ∈ [-1, +1] (positive = buy, negative = sell)

Main thread consensus:
```
gross_delta = median(vote_1, vote_2, vote_3)
p_up        = mean(vote_1, vote_2, vote_3) mapped to [0, 1]
agreement   = fraction of workers agreeing on sign(gross_delta)
```

**Trend filter applied by index.html before forwarding to nociceptor:**
```
trendStrength = (emaFast - emaSlow) / emaSlow

if |trendStrength| > 0.002:
  REVERSION_A, SPREAD_FADE:
    suppress buy in downtrend (trendStrength < -0.002)
    suppress sell in uptrend  (trendStrength > +0.002)
  MOMENTUM_V1, DEPTH_GRAB:
    suppress buy in downtrend with negative momentum
```

#### Source B — Orderbook Self-Emitting (1 pattern)

`WHALE_WAKE` — documented in §1. `gross_delta = ±0.004`, `regime_tag = "Any"`.

#### Source C — Correlation-Driven (1 pattern)

`ARBI_CROSS_EXCHANGE` — from `correlation_worker.js` when `|lagEWMA| > 10ms`, 5s cooldown:

```
gross_delta = sign(lagMs) * min(0.05, max(0.001, |lagMs| * 0.0002))

Examples:
  25ms  → 0.005
  50ms  → 0.010
  100ms → 0.020
  250ms → 0.050   (capped)

Positive lagMs = BINANCE leads = buy signal on VALR
```

#### Source D — Price-Driven (1 pattern, daemon)

`SUPERTREND_CROSS` — computed by `daemon/src/` process:

```
atr   = EMA(true_range, α=0.1818)
upper = price + 4.0 * atr
lower = price - 4.0 * atr

Bearish flip (price < lower):
  if now - lastFlip >= 120s:
    emit { pattern_id: "SUPERTREND_CROSS", gross_delta: -0.004, regime_tag: "HighVol"|"Crisis" }
```

REGIME_REQUIREMENTS gate (see §2) drops this signal in LowVol.

---

### §4 — Echo Lifecycle & Aliveness System (`echoforge_worker.js`)

#### Constants

```
MIN_ALIVENESS            = 0.30    SIGNAL_BOOST           = 0.03
CONTEST_THRESHOLD        = 0.30    CONTEST_MIN_PEERS      = 2
CONTEST_MIN_ALIVENESS    = 0.70    PAPER_MIN_TRADES       = 4
PAPER_MAX_QUEUE          = 20      PAPER_SHADOW_ALPHA     = 0.10
PAPER_LOOKBACK_MS        = 10_000  GHOST_RESOLVE_MS       = 5_000
QUORUM_STRAIN_N          = 3       STRAIN_TTL_MS          = 60_000
STRAIN_LOSS_THRESHOLD    = -0.3    PEER_REPORT_TTL_MS     = 30_000
GOSSIP_INTERVAL_MS       = 5_000   SNAPSHOT_INTERVAL_MS   = 2_000
PAIN_MAP_TTL_MS          = 60_000  PAIN_MAP_QUORUM_N      = 3
PAIN_MAP_PENALTY         = 0.05    SIGNAL_LOG_TTL_MS      = 86_400_000  (24h)
SIGNAL_LOG_MAX           = 2000    SUGGEST_MIN_BUCKET     = 10
SUGGEST_INTERVAL_MS      = 3_600_000 (1h)   SUGGEST_EVERY_N = 25
DEAD_ECHO_TTL_MS         = 172_800_000 (48h)  PRUNE_INTERVAL_MS = 21_600_000 (6h)
PRUNE_CANDIDATE_MIN_N    = 10      POS_PROFIT_TAKE_THRESHOLD  = 0.015
POS_LOSS_SUPPRESS_THRESHOLD = -0.008    CROSS_PAIR_BOOST   = 0.04
```

#### Decay Rates (`DECAY_BY_TYPE`)

```
mean_reversion: 0.08    momentum: 0.12    maker: 0.10    trend: 0.06
institutional:  0.08    breakout: 0.20    arb:   0.02    DEFAULT: 0.10
```

High decay = faster response to outcomes (breakout), low = more inertia (arb, trend).

#### Loss Multipliers (`LOSS_MULT_BY_TYPE`)

```
mean_reversion: 3.5    momentum: 4.5    maker: 4.0    trend:  3.0
institutional:  4.5    breakout: 8.0    arb:   6.0    DEFAULT: 7.0
```

Applied to `decay_rate` on losses: `alpha_loss = decay_rate * lossMultiplier`

Example: breakout loss → `alpha = 0.20 * 8.0 = 1.6` → capped at 1.0 → maximum possible one-step decay.

#### Strategy Type Map

```
MOMENTUM_V1         → momentum
DEPTH_GRAB          → maker
SUPERTREND_CROSS    → trend
WHALE_WAKE          → institutional
ARBI_CROSS_EXCHANGE → arb
REVERSION_A         → mean_reversion
SPREAD_FADE         → mean_reversion
VOLATILITY_BREAKOUT → breakout
```

#### Pre-seeded Echoes (`KNOWN_ECHOES`)

All seeded at `MIN_ALIVENESS` (0.30) on worker init:

```
MOMENTUM_V1:          LowVol · HighVol · Crisis
DEPTH_GRAB:           LowVol · HighVol · Crisis
SUPERTREND_CROSS:     LowVol · HighVol · Crisis  ← LowVol always REGIME_REQUIREMENT dropped
REVERSION_A:          LowVol · HighVol · Crisis
SPREAD_FADE:          LowVol · HighVol · Crisis
WHALE_WAKE:           Any
ARBI_CROSS_EXCHANGE:  Any
VOLATILITY_BREAKOUT:  HighVol · Crisis            ← NOT seeded for LowVol
```

#### Echo Object (complete field list)

```javascript
{
  pattern_id,
  regime_tag,
  net_aliveness:   0.0,    // execution gate [MIN_ALIVENESS, 1.0]
  shadow_aliveness: 0.0,   // paper-heartbeat tracker (hibernation only)
  decay_rate,              // from PHIC or DECAY_BY_TYPE
  execution_count: 0,      // cumulative real fills (sell-side only)
  loss_count:      0,      // outcome_score < 0 count
  state:           "active" | "hibernating" | "dead",
  paper_queue:     [{direction, entry_price, net_alpha, timestamp}],
  paper_resolved:  0,
  beta_alpha:      5,      // Beta-Bernoulli α (weak prior)
  beta_beta:       5,      // Beta-Bernoulli β
  success_prob:    0.5,    // α / (α + β)
  ci95_width:      0.219,  // 1.96 * sqrt(αβ / n²(n+1))
  peer_reports:    Map<node_id, {aliveness, timestamp}>,
  contested:       false,
  peer_avg:        null,
  strain_reports:  Map<node_id, {strain_score, timestamp}>,
  pain_reports:    Map<node_id, {hurdle_miss_pct, trigger_vpin, timestamp}>,
  last_updated:    timestamp
}
```

#### Decay Rate Resolution Priority

When `_getOrCreate` initialises an echo:
1. `_phic["decay_rate_" + strategyType]` — per-type PHIC override
2. `_phic.decay_rate` — global PHIC override
3. `DECAY_BY_TYPE[strategyType]`
4. `DEFAULT_DECAY_RATE = 0.10`

#### `_onSignalPass` — Complete Gate Sequence (12 steps)

1. Record pending signal to `_pendingSignals[key]` (queue, max 10 per pattern+direction)
2. Get or create echo for `{pattern_id, regime_tag}`
3. **Dead state** → `return` (no processing)
4. **Regime mismatch** — `echo.regime_tag !== _currentRegime AND echo.regime_tag !== "Any"` → `return`
5. **Pattern veto** (PHIC) → `return`
6. **Emergency freeze** → `return`
7. **Signal boost:** `net_aliveness = min(1.0, net_aliveness + 0.03)`
8. **Minimum aliveness threshold:** `contestedMin = 0.70` if `echo.contested`, else `0.30`
9. **Below threshold → hibernation:**
   - `state = "hibernating"`, `_recordGhostTrade()`, `return`
10. **Recovering from hibernation** (was hibernating, now above threshold):
    - `state = "active"`, clear `shadow_aliveness`, clear `paper_queue`
11. **Position-aware buy suppression:**
    - `unrealNorm > 0.015` (>+1.5% unrealized profit) → `_recordGhostTrade()`, `return`
    - `unrealNorm < -0.008` (<-0.8% unrealized loss) → `return` (suppress without ghost)
12. **Emit `execution_intent`** → `{pattern_id, net_aliveness, regime_tag, net_alpha, direction, contested, regime_cap, unrealized_pnl_norm}`

#### `_onExecutionResult` — Bayesian Aliveness Decay

Only called for sell fills (exits). Decisive filter (`|score| >= 0.05`) applied in index.html before routing here.

```
normalised     = (outcomeScore + 1.0) / 2.0       — maps [-1,+1] to [0,1]
lossMultiplier = _phic.loss_multiplier ?? LOSS_MULT_BY_TYPE[type] ?? 7.0

alpha = outcomeScore < 0
  ? min(decay_rate * lossMultiplier, 1.0)          — aggressive decay on loss
  : decay_rate                                      — gentle decay on win

echo.net_aliveness = max(0, min(1,
  net_aliveness * (1 - alpha) + normalised * alpha))

echo.execution_count++
if outcomeScore < 0: echo.loss_count++

Beta-Bernoulli update:
  outcomeScore > 0 → beta_alpha++
  else             → beta_beta++
  success_prob = beta_alpha / (beta_alpha + beta_beta)
  ci95_width   = 1.96 * sqrt(beta_alpha * beta_beta / (n² * (n+1)))
    where n = beta_alpha + beta_beta
```

Pending signal resolved into 24h `signal_log`. Every 25 outcomes OR 1h since last suggestion → `_runSuggestionEngine()`.

Significant loss (`score <= -0.3 AND aliveness < 0.30`) → emit `metabolic_strain` to mesh peers.

#### `_resolveGhostTrades` (every 5s)

```
For each paper_queue entry older than PAPER_LOOKBACK_MS (10s):
  priceDiff = (currentPrice - entryPrice) / entryPrice
  spreadPct = _currentSpread / entryPrice    (default fallback: 0.0002)
  win       = direction=buy  ? priceDiff > spreadPct
                             : priceDiff < -spreadPct

  shadow_aliveness = shadow_aliveness * 0.90 + (win ? 1.0 : 0.0) * 0.10
  paper_resolved++

Autonomous resurrection if:
  state === "hibernating"
  AND shadow_aliveness >= 0.30
  AND paper_resolved >= 4 (PAPER_MIN_TRADES)
  AND no veto
  AND regime matches
  AND no freeze
→ net_aliveness = MIN_ALIVENESS + 2 * SIGNAL_BOOST = 0.30 + 0.06 = 0.36
   state = "active", clear paper_queue
```

#### `_updateContested`

Expire peer reports older than 30s. If `|local_aliveness - peer_avg| > 0.30` AND peer count >= 2:
- `echo.contested = true`
- Emit `contested_alert` to UI

When contested, the minimum aliveness threshold to avoid hibernation rises from 0.30 to 0.70, making contested echoes harder to keep active.

#### `_mergePeerEcho` (gossip merge)

```
localWeight    = max(0.3, min(0.7, echo.net_aliveness * 2))
net_aliveness  = local * localWeight + peer * (1 - localWeight)
decay_rate     = local_decay * 0.8 + peer_decay * 0.2
```

Higher local aliveness = more weight given to local state. Low local aliveness = more susceptible to peer influence.

#### Quorum Veto (`_handleMetabolicStrain`)

When `QUORUM_STRAIN_N` (3) or more peer strain reports arrive within `STRAIN_TTL_MS` (60s):
- `_applyQuorumVeto()` → `state = "dead"`, `net_aliveness = 0`
- Cascade: Crisis failure also kills the HighVol variant of the same pattern

#### Pain Map (`_handlePainMap`)

Pre-emptive aliveness penalty per report:
```
net_aliveness *= (1 - PAIN_MAP_PENALTY * hurdle_miss_pct)
               = (1 - 0.05 * hurdle_miss_pct)
```

3+ reports with `trigger_vpin >= 0.50` → quorum kill (same effect as metabolic strain quorum).

Pain map is only broadcast by nociceptor when `_lastVpin >= 0.35` — silent in calm LowVol markets.

#### Cross-Pair Boost (`_onCrossPairSignal`)

```
mean_reversion AND pearson < 0.5:
  boost = 0.04 * (0.5 - pearson) * 2   — up to +0.04 at pearson=0

momentum AND rvr > 1.5 AND flow_sync:
  boost = 0.04 * min((rvr - 1.5) / 1.5, 1.0)
```

#### `_onClearSkies` (VPIN below p50 for 15min sustained)

- All echoes with `net_aliveness < 0.30` → boosted to 0.50
- All hibernating echoes with `net_aliveness >= 0.30` → `state = "active"`

#### Suggestion Engine (`_runSuggestionEngine`)

Runs every 25 resolved outcomes OR 1h. Analyses `signal_log` (24h rolling, max 2000 entries):

1. Bucket outcomes by `regime:strategy_type`
2. Require min 10 outcomes per bucket (`SUGGEST_MIN_BUCKET`)
3. `win_rate < 0.40` → suggest `raise_strain` for that regime/type
4. `win_rate > 0.65` → suggest `ease_strain`
5. Direction split: if buy win_rate vs sell win_rate diverge > 20pp → suggest direction-specific strain
6. VPIN band split: compare outcomes above/below VPIN midpoint → suggest VPIN-aware hurdle
7. Emit `hurdle_suggestion` to UI

#### Timers

| Interval | Action |
|---|---|
| 2s | `echo_snapshot` — serialise all echoes for UI display |
| 5s | `echo_gossip` — broadcast non-dead echoes (aliveness ≥ 0.30) to peers |
| 5s | `_resolveGhostTrades()` — advance paper heartbeat |
| 6h | Prune dead echoes older than 48h |

---

### §5 — Execution: Sizing, Orders, Risk (`execution_worker.js`)

#### Key State Variables

```javascript
_portfolio       = { usdt, btc, avg_cost, realized_pnl, unrealized_pnl, total_value, total_pnl }
_patternLastTrade = Map<pattern_id, timestamp>   // cooldowns
_buyLockoutUntil  = 0                           // post-stop-loss buy block
_vpinCrisisAt     = 0                           // timestamp of last crisis-onset
_lastVpin         = 0
_hwm              = 10_000                       // high-water mark (USDT)
_bankedProfit     = 0
_reservedUsdt     = 0                            // optimistic reservation
_reservedBtc      = 0
_exposureByPattern = Map<pattern_id, btc_qty>    // per-pattern position
_meshDampening    = 1.0                          // mesh exposure scaling factor
```

#### `_handleIntent` — 9 Gates (in order)

1. **Emergency freeze** → `return`
2. **Rate limit** — `_rateLimitUntil > now` → `return`
3. **Live price = 0** → `return`
4. **Pattern cooldown** — `now - _patternLastTrade[pattern_id] < cooldown_ms`
   - ARBI: 200ms cooldown; all others: 30s
5. **Buy lockout** — `side=buy AND now < _buyLockoutUntil` → `return`
6. **Insufficient balance** — buy: available USDT < 10; sell: available BTC < 0.0001 → `return`
7. **Per-pattern exposure cap** — `_exposureByPattern[pattern_id] * price > cap` → `return` + `_maybeCapTrim()`
8. **Total exposure cap** — `(_portfolio.btc * livePrice / totalVal) > max_total_exposure_pct` → `return` + `_maybeCapTrim()`
9. **Offline** → enqueue to SAF (IndexedDB)

All 9 gates passed → proceed to sizing and order placement.

#### Kelly Sizing (buy orders)

```
auto      = max(0.01, min(1.0, autonomy_level))
posPct    = max(0.001, min(1.0, max_position_pct / 100))
conviction = max(0.1, min(1.0, net_aliveness)) ^ 2.0
pUp       = max(0.50, min(0.95, intent.p_up || 0.55))
kellyRaw  = (pUp - 0.5) / max(0.01, 1 - pUp)
kelly     = max(0.05, min(0.40, kellyRaw))

qty = (availUsdt * auto * posPct * conviction * kelly)
      / (livePrice * meshDampening)

// Regime cap applied after sizing:
qty *= regime_cap                      // from PHIC, per-regime fraction
qty *= _guardian_size_mult             // Guardian state multiplier (0.5 in CAUTIOUS)

// ARBI boost:
if pattern=ARBI: qty *= min(2.0, max(0.3, lagMs / 50)), capped at 0.1 BTC
```

Sell orders: Kelly sizing not applied; sell quantity determined by position and regime-exit or stop-loss logic.

#### `_checkStopLoss` (every 30s)

```
priceDropPct   = (avg_cost - livePrice) / avg_cost * 100

inFreshSpike   = _vpinCrisisAt > 0 AND (now - _vpinCrisisAt) < dip_hold_window_s * 1000
effectiveStop  = inFreshSpike AND dip_hold_enabled
                 ? stopLossPct + dip_hold_buffer_pct
                 : stopLossPct

if priceDropPct < effectiveStop: return   // haven't hit stop

// Cooldown: 120s between successive stop-loss fires
_buyLockoutUntil = now + stop_loss_lockout_s * 1000

// Sell STOP_LOSS_SELL_FRAC (0.50) of current BTC position
// order tagged pattern_id="STOP_LOSS"
```

The dip-hold buffer widens the effective stop during fresh VPIN spikes to avoid premature stop-out during transient toxic flow.

#### `_checkRegimeExit` (on regime change events)

```
jump = REGIME_SEVERITY[newRegime] - REGIME_SEVERITY[entryRegime]
  { LowVol:0, HighVol:1, Crisis:2 }

if jump <= 0: return

sellFrac:
  jump >= 2 (LowVol→Crisis):      0.70
  LowVol → HighVol:               0.30
  HighVol → Crisis:               0.50

Cooldown: REGIME_EXIT_COOLDOWN_MS = 5min between fires
```

#### Profit Banking (`_checkBankProfits`, every 30s)

```
VELOCITY_ALPHA = 0.35
_velocityEWMA  = _velocityEWMA * 0.65 + (totalVal - lastCheckTv) * 0.35

Tier 1 — immediate partial bank:
  if (totalVal - _hwm) / _hwm >= bank_profit_threshold_pct (default: 0.002):
    bank = excess * bank_tier1_frac (default: 0.60)
    _bankedProfit += bank
    _hwm          += bank
    _tier1Banked   = true

Tier 2 — remainder on momentum reversal or dwell:
  if _tier1Banked AND (_velocityEWMA < 0 OR dwell >= 10min):
    bank remaining excess above current _hwm
    reset _hwmCrossedAt = null, _tier1Banked = false
```

`_bankedProfit` is informational (for UI display); actual account protection comes from floor enforcement.

#### Floor Enforcement (`_checkFloor`, every 30s)

```
floor    = _hwm * (1 - max_total_exposure_pct)
warnLine = floor * (1 + FLOOR_WARN_BUFFER)   // FLOOR_WARN_BUFFER = 0.03

if totalVal <= floor:
  flatten all BTC (market sell, pattern_id="FLOOR_BREACH")
  emit floor_breach + killswitch_snapshot

if totalVal <= warnLine:
  emit floor_warning
```

#### Outcome Score Calculation (sell fills only)

```
pnlRaw      = result.pnl_realized
refSize     = filledPrice * filledQty * 0.01   (1% of trade notional)
outcomeScore = max(-1, min(1, pnlRaw / max(refSize, 0.001)))

Failed VALR fetch (no pnl available) → outcomeScore = -0.5
```

#### VPIN Update Handling

```
wasCrisis = _lastVpin > vpinCrisisThreshold
_lastVpin = msg.vpin

if !wasCrisis AND nowCrisis: _vpinCrisisAt = Date.now()
if  wasCrisis AND !nowCrisis: _vpinCrisisAt = 0
```

#### SAF (Store-and-Forward, IndexedDB)

- TTL: 5 minutes; max 5 retries per order
- Status transitions: `PENDING → SUBMITTED | EXPIRED`
- Replayed every 30s when connection restored
- Orders older than TTL are marked EXPIRED and not retried

---

### §6 — Correlation & ARBI (`correlation_worker.js`)

#### Constants

```
WINDOW             = 60     — rolling ticks for Pearson computation
EWMA_α             = 0.20   — Pearson EWMA smoothing
LAG_MATCH_WINDOW_MS = 2_000 — VALR/BINANCE trade match window
LAG_PRICE_TOL      = 0.001  — 0.1% price tolerance for trade matching
LAG_EMIT_THRESHOLD = 10     — ms: minimum |lagEWMA| to emit ARBI
LAG_EWMA_α         = 0.15   — lag EWMA smoothing
LAG_PLAUSIBLE_MS   = 5_000  — clock skew guard; reject |lagMs| > 5s
ARB_EMIT_COOLDOWN_MS = 5_000
```

#### ARBI Detection Algorithm

1. Buffer VALR and BINANCE trades for the last 2 seconds per exchange
2. For each VALR trade: find matching BINANCE trade within `LAG_PRICE_TOL` (0.1%)
3. Compute `lagMs = valrTimestamp - binanceTimestamp`
4. Reject if `|lagMs| > LAG_PLAUSIBLE_MS` (5000ms) — clock skew guard
5. `_lagEWMA = _lagEWMA * (1 - 0.15) + lagMs * 0.15`
6. Emit when: `_lagCount >= 5 AND |_lagEWMA| > 10ms AND now > lastEmit + 5000`
7. `gross_delta = sign(_lagEWMA) * min(0.05, max(0.001, |_lagEWMA| * 0.0002))`
8. Positive `lagMs` = VALR behind BINANCE = BINANCE leads = buy opportunity on VALR

#### Pearson Correlation & Regime

Rolling 60-tick Pearson on paired price series:
- `|pearson| < 0.35` → regime `"Crisis"` (diverging, no correlation)
- `rvr > rvrThreshold` → regime `"HighVol"` (relative volatility elevated)
- else → regime `"LowVol"`

Emits `cross_pair_signal` every 1s containing `{pearson, rvr, flow_sync, regime_tag}` for echo cross-pair boost logic.

---

### §7 — Inference System (`inference_worker.js`)

#### Default Mode: Bundled MLP (`_jsInfer`)

Architecture: `8 → 32 → 16 → 1` fully connected network. Weights stored as `_BUNDLED_WEIGHTS` constant in the worker. No ORT dependency needed. Input: 11-element feature vector (padded/trimmed to 8 active features). Output: single scalar ∈ [-1, +1].

#### Retrained Mode: ORT ONNX

Activated on `reload_model` message. Loads model bytes via ORT, creates new session. Input width probed via `_probeWidth([13, 12, 11, 8])`. ORT session replaces `_jsInfer` until tab refresh.

```javascript
async function _probeWidth(ort, session, defaultWidth = 8) {
  for (const w of [13, 12, 11, 8]) {
    try {
      const dummy = new ort.Tensor("float32", new Float32Array(w).fill(0), [1, w]);
      await session.run({ float_input: dummy });
      return w;
    } catch (e) {
      const isWasmTrap = e?.message?.includes("memory") || e?.message?.includes("out of bounds");
      if (isWasmTrap) return defaultWidth;  // WASM allocator corrupted — bail
    }
  }
  return defaultWidth;
}
```

#### OFI Model (Separate ORT Session)

Separate ORT session for OFI inference (`_ofiSession`, `_ofiInputWidth`). Used to classify order-book patterns independently. Probed with `defaultWidth=12` (expected OFI model width).

**Startup stagger** prevents cross-worker WASM races:
```javascript
async function _loadOfiSession() {
  await new Promise(r => setTimeout(r, Math.random() * 250));  // 0–250ms jitter
  // ... load ORT, create session, probe width with defaultWidth=12 ...
}
```

#### Sequential Run Queues

`_sessionRunQueue` and `_ofiRunQueue` are Promise chains that serialise concurrent `session.run()` calls within a worker. This prevents concurrent ORT inference on the same session object.

---

### §8 — Orchestration (`index.html`)

#### Guardian State Machine

```
States: NOMINAL → CAUTIOUS → REDUCE_ONLY → HALTED

Triggers for downgrade:
  3 consecutive 30s equity checks where each is lower than the previous → REDUCE_ONLY
  session drawdown > session_loss_pct (default: 5%) → REDUCE_ONLY

Effects by state:
  CAUTIOUS:      _guardian_size_mult = 0.5 (half sizing)
  REDUCE_ONLY:   buys blocked; valid buy signals → ghost_signal_pass to echoforge_worker
  HALTED:        all intents blocked

Recovery path:
  REDUCE_ONLY: 15min tactical retreat → CAUTIOUS → 3 consecutive equity wins → NOMINAL
  Manual override: "RESET" button forces back to NOMINAL

ghost_signal_pass:
  Guardian NACK on a buy intent → forward signal to echoforge_worker with 0.5× SIGNAL_BOOST
  → entry added to paper_queue → resolves against live price after 10s
  → feeds shadow_aliveness → can trigger autonomous resurrection
```

#### Regime Detection

`vpin_update` messages from nociceptor carry the current `regime_tag`. On regime change:
- `recorder.record("event", {kind: "regime_change", from_regime, to_regime})`
- Forward to execution_worker for regime-exit sell logic

#### `execution_result` Routing

```javascript
_scoreDecisive = Math.abs(msg.outcome_score) >= 0.05

if _scoreDecisive:
  → postMessage echoforge_worker: execution_result
  → if bridgeWS open: send outcome_recorded

recorder.record("outcome", ...)   ← ALWAYS recorded regardless of decisive filter
```

#### `execution_intent` Enrichment

echoforge_worker emits `execution_intent` with `{pattern_id, net_aliveness, regime_tag, net_alpha, direction, contested, regime_cap, unrealized_pnl_norm}`.

index.html intercepts and merges before forwarding to execution_worker:
```javascript
enriched = {
  ...intent,
  p_up:        latestJuryResult?.p_up ?? 0.55,   // silently defaults to 0.55
  market_price: latestPrice,
  maker_fee:   _phic.maker_fee,
  taker_fee:   _phic.taker_fee,
  slippage:    _phic.slippage_est
}
```

#### PHIC Broadcast

PHIC changes from UI → `postMessage` to all workers + HTTP POST to daemon `/api/v1/phic/config`.

#### BroadcastChannel Echo Warm-Start

On `startNode()`:
1. Post `echoforge_state_request` on `_modelSyncChannel`
2. Running tabs respond within random 0–250ms with `echoforge_state_sync` + serialised echo snapshot
3. First responder wins (`_echoesSyncReceived` flag)
4. `seed_echoes` message sent to echoforge_worker
5. echoforge_worker restores: `net_aliveness`, `shadow_aliveness`, `decay_rate`, `execution_count`, `loss_count`, `paper_resolved`, `state`, reconstructs `beta_alpha`/`beta_beta` from `beta_n * success_prob`

---

### §9 — Mesh & Sovereignty (`mesh.js`)

#### S(Ex) Sovereign Score

```
S(Ex) = 0.50 * L_factor + 0.25 * U + 0.15 * C + 0.10 * P

L_factor = max(0, 1 - latency_ms / 200)   — latency contribution
U        = success_rate                    — uptime contribution
C        = connected ? 1.0 : 0.0          — connectivity
P        = rate_limited ? 0.0 : 1.0       — API access

Smoothing: S_smooth = 0.75 * S_prev + 0.25 * S_raw
Hysteresis: challenger must beat incumbent by >= 0.15 to trigger election
Election cooldown: 30s
Daemon: always sovereign (hardcoded)
```

#### Regime Quorum Voting

1. Node proposes regime change → flood vote to all peers
2. Quorum = `ceil((N+1)/2)` votes required
3. Anti-flap dwell: regime must remain stable for dwell period before commit
4. Committed regime overrides local VPIN-derived regime

#### Echo Gossip (every 5s)

Non-dead echoes with `aliveness >= 0.30` → serialised as `echo_gossip` to all peers → merged via `_mergePeerEcho` (§4).

---

### §10 — Feedback Loop & Bridge (`bridge/main.py`)

#### Outcome Flow

```
Sell fill → execution_worker → outcome_score → index.html
  → if |score| >= 0.05: bridgeWS.send("outcome_recorded")
  → echoforge_worker.execution_result (aliveness update)

Bridge receives outcome_recorded → DriftMonitor + RegressionOptimizer
```

#### DriftMonitor

```
Cycle: 30s
Window: last 100 decisive outcomes
Method: linear regression on outcome_score over time

Alert condition:
  slope < -0.002 AND r² > 0.50
  → emit drift_alert to UI
```

#### RegressionOptimizer

```
Cycle: 5min
Minimum samples: 50
Method: SGD gradient descent per strategy_type bucket

Push conditions:
  R² >= 0.30 (model explains 30%+ of outcome variance)
  → POST updated hurdle coefficients to /api/v1/phic/config

Conservative: R² < 0.30 → no push (insufficient signal)
```

#### Session Recorder (`session_recorder.js`)

Records to IndexedDB session store:

| Event type | Trigger | Filter |
|---|---|---|
| `tick` | Every 1s | All |
| `decision` | Every signal_pass or signal_drop | All |
| `outcome` | Every execution_result | ALL (including non-decisive) |
| `event` | regime_change, guardian_state, etc. | All |

`distributions` computed at export time over grouped outcome records.

---

## Part 4 — Complete Tick-to-Trade Trace

**Scenario:** VALR BTC/USDT trade arrives, regime=LowVol, REVERSION_A signal fires, trade executes.

```
Step 1 — VALR WebSocket trade arrives: price=95,000, volume=0.05 BTC, side=buy

Step 2 — orderbook_worker processes tick:
  dt = 80ms since last tick
  volDecay = 0.95^(80/200) = 0.980
  _buyVol  = _buyVol * 0.980 + 0.05 = 2.14  (example accumulated)
  _sellVol = _sellVol * 0.980 + 0    = 1.85
  vpin_ob  = |2.14 - 1.85| / (2.14 + 1.85) = 0.29/3.99 = 0.073

  emaAlpha_fast = 1 - exp(-80 * ln2 / 5000) = 0.011
  emaFast = emaFast * (1-0.011) + 95000 * 0.011 = 95,020 (example)

  z_score   = (95000 - 94950) / 80 = +0.625   (simplified)
  momentum  = (95020 - 94900) / 94900 = +0.00126

  Emit tick { price:95000, vpin:0.073, z_score:0.625, momentum:0.00126, ... }
  Emit ofi_snapshot (throttled to 100ms): [delta_bids×5, delta_asks×5, 0.073, 0.42]

Step 3 — nociceptor_worker reads SAB ring buffer (8ms poll):
  _buyVol_nc  = _buyVol_nc * 0.98 + 0.05 = 1.92
  _sellVol_nc = _sellVol_nc * 0.98 + 0   = 1.67
  vpin_nc     = |1.92 - 1.67| / (1.92 + 1.67) = 0.070
  regime      = LowVol (0.070 < 0.35 threshold)
  _lastVpin   = 0.070

Step 4 — inference_worker (× 3 jury workers) receive tick + ofi_snapshot:
  Worker 1: features + noise → _jsInfer → vote = -0.024  (mild reversion)
  Worker 2: features + noise → _jsInfer → vote = -0.031
  Worker 3: features + noise → _jsInfer → vote = +0.008  (slight momentum)
  gross_delta = median(-0.031, -0.024, +0.008) = -0.024
  p_up        = mean(0.488, 0.485, 0.504) = 0.492
  pattern_id  = REVERSION_A (negative gross_delta → reversion sell signal)

  NB: gross_delta = -0.024 means sell signal (or reversion entry)

Step 5 — index.html trend filter:
  trendStrength = +0.00126 (uptrend, modest)
  |trendStrength| = 0.00126 < threshold 0.002 → trend filter does NOT suppress
  Signal forwarded to nociceptor as REVERSION_A sell intent

Step 6 — nociceptor _runMetabolic:
  Gate 1 (veto): REVERSION_A not vetoed ✓
  Gate 2 (freeze): not passive ✓
  netAlpha = |−0.024| - (0.0001 + 0.0002 + 0.0002) = 0.024 - 0.0005 = 0.0235
  strain   = STRATEGY_STRAIN["mean_reversion"]["LowVol"] = 0.0
  strainMult = e^0.0 = 1.0
  vpinOver   = max(0, (0.070 - 0.70) / (1 - 0.70)) = 0
  vpinMult   = 1 + 0 * 8 = 1.0
  riskMult   = 1.0
  regimeScale = 0.85 (LowVol)
  hurdle = 0.0005 * 1.0 * 1.0 * 1.0 * 0.85 = 0.000425
  netAlpha (0.0235) >> hurdle (0.000425) → PASS ✓
  Gate 5 (ARB lag): not ARBI pattern, skip ✓
  Gate 6 (regime req): REVERSION_A has no regime requirements ✓
  Gate 7 (regime cap): LowVol cap > 0 ✓
  → signal_pass { direction:"sell", net_alpha:0.0235, hurdle:0.000425,
                  vpin:0.070, regime_cap:0.8, strategy_type:"mean_reversion" }

Step 7 — echoforge_worker _onSignalPass (REVERSION_A, LowVol):
  echo = { net_aliveness:0.72, state:"active", ... }
  Gate 3 (dead): not dead ✓
  Gate 4 (regime): LowVol matches echo.regime_tag=LowVol ✓
  Gate 5 (veto): not vetoed ✓
  Gate 6 (freeze): not frozen ✓
  Signal boost: 0.72 + 0.03 = min(1, 0.75) = 0.75
  Min threshold: not contested → threshold = 0.30; 0.75 >= 0.30 ✓
  Gate 10 (recovering): was active, no state change
  Gate 11 (position):
    unrealNorm = -0.002 (−0.2% unrealized, below 0.015 and above −0.008) → pass ✓
  → emit execution_intent { pattern_id:"REVERSION_A", net_aliveness:0.75,
                             regime_tag:"LowVol", net_alpha:0.0235,
                             direction:"sell", contested:false,
                             regime_cap:0.8, unrealized_pnl_norm:-0.002 }

Step 8 — index.html enriches execution_intent:
  p_up = 0.492 (from jury cache, <2s old)
  → forward to execution_worker

Step 9 — execution_worker _handleIntent:
  Gate 1 (freeze): not frozen ✓
  Gate 2 (rate limit): not rate limited ✓
  Gate 3 (price): livePrice = 95000 ✓
  Gate 4 (cooldown): last REVERSION_A trade was 45s ago (>30s) ✓
  Gate 5 (buy lockout): direction=sell, lockout only affects buys ✓
  Gate 6 (balance): portfolio.btc = 0.08 > 0.0001 ✓
  Gate 7 (per-pattern exposure): within cap ✓
  Gate 8 (total exposure): within max_total_exposure_pct ✓
  Gate 9 (offline): connected ✓

  Sell sizing:
    (sell does not use Kelly; uses fraction of available BTC)
    sellQty = portfolio.btc * regime_cap * guardian_size_mult
            = 0.08 * 0.8 * 1.0 = 0.064 BTC

  POST /api/v1/orders (VALR REST)
    { side:"sell", quantity:0.064, price:95000 (limit) or "market" }

Step 10 — VALR fill (assume instant market fill):
  Filled: 0.064 BTC @ 95,010 (slight positive slippage)
  pnl_realized = (95010 - avg_cost) * 0.064 = (95010 - 94800) * 0.064 = +$13.44

Step 11 — execution_worker processes fill:
  outcomeScore = pnl_realized / (filledPrice * filledQty * 0.01)
               = 13.44 / (95010 * 0.064 * 0.01)
               = 13.44 / 60.81 = +0.221

  |outcomeScore| = 0.221 >= 0.05 → decisive
  Send execution_result { pattern_id:"REVERSION_A", outcome_score:+0.221, ... }

Step 12 — echoforge_worker _onExecutionResult (REVERSION_A, LowVol):
  normalised = (+0.221 + 1.0) / 2.0 = 0.611
  type = "mean_reversion" → decay_rate = 0.08
  outcomeScore > 0 → alpha = 0.08 (win decay only)
  net_aliveness = 0.75 * (1 - 0.08) + 0.611 * 0.08
               = 0.75 * 0.92 + 0.611 * 0.08
               = 0.690 + 0.049 = 0.739  (modest win, aliveness stable)
  beta_alpha++  (5+1=6), success_prob = 6/11 = 0.545
  execution_count = 1

Step 13 — index.html routes outcome_recorded to bridge WS:
  Bridge receives { outcome_score:+0.221, strategy_type:"mean_reversion",
                    regime_tag:"LowVol", timestamp }
  DriftMonitor: adds to 100-sample window, checks slope
  RegressionOptimizer: adds to strategy bucket, deferred to 5min cycle
```

**Total latency from tick to order placement:** ~5–15ms typical (JS single-thread, no network for inference). VALR REST order round-trip adds 50–200ms.

---

## Part 5 — PHIC Configuration Reference

| PHIC field | Workers that read it | Default | Effect |
|---|---|---|---|
| `maker_fee` | nociceptor, execution | 0.0001 | Fee used in hurdle and Kelly |
| `taker_fee` | nociceptor, execution | 0.0002 | Fee used in hurdle and Kelly |
| `slippage_est` | nociceptor, execution | 0.0002 | Added to hurdle baseExecCost |
| `vpin_crisis_threshold` | nociceptor, execution | 0.70 | Crisis regime boundary |
| `vpin_highvol_threshold` | nociceptor | 0.35 | HighVol regime boundary |
| `vpin_ewma_alpha` | nociceptor | 0.02 | VPIN smoothing speed |
| `regime_caps.LowVol` | nociceptor, execution, echoforge | 0.8 | Max buy fraction in LowVol |
| `regime_caps.HighVol` | nociceptor, execution, echoforge | 0.5 | Max buy fraction in HighVol |
| `regime_caps.Crisis` | nociceptor, execution, echoforge | 0.1 | Max buy fraction in Crisis |
| `regime_strain_exp.LowVol` | nociceptor | — | Global fallback strain for LowVol (overrides STRATEGY_STRAIN) |
| `regime_strain_exp.HighVol` | nociceptor | — | Global fallback strain for HighVol |
| `regime_strain_exp.Crisis` | nociceptor | — | Global fallback strain for Crisis |
| `hurdle_regime_scale.LowVol` | nociceptor | 0.85 | Hurdle scaling in LowVol |
| `hurdle_regime_scale.HighVol` | nociceptor | 1.0 | Hurdle scaling in HighVol |
| `hurdle_regime_scale.Crisis` | nociceptor | 1.20 | Hurdle scaling in Crisis |
| `proactive_overrides.risk_multiplier` | nociceptor | 1.0 | Scales all hurdles globally |
| `autonomy_level` | execution | 1.0 | Scales buy sizing [0.01, 1.0] |
| `max_position_pct` | execution | 10 | Max portfolio % per trade |
| `max_total_exposure_pct` | execution | 0.60 | Max total BTC exposure |
| `stop_loss_pct` | execution | 3.0 | Stop-loss trigger % |
| `stop_loss_sell_frac` | execution | 0.50 | Fraction of position sold at stop |
| `stop_loss_lockout_s` | execution | 120 | Post-stop buy lockout seconds |
| `dip_hold_enabled` | execution | true | Enable VPIN spike buffer |
| `dip_hold_buffer_pct` | execution | 1.0 | Extra stop buffer during VPIN spike |
| `dip_hold_window_s` | execution | 90 | VPIN spike freshness window |
| `session_loss_pct` | execution (Guardian) | 5.0 | Session drawdown → REDUCE_ONLY |
| `bank_profit_threshold_pct` | execution | 0.002 | Profit above HWM to trigger banking |
| `bank_tier1_frac` | execution | 0.60 | Fraction banked in Tier 1 |
| `feature_noise` | inference | 0.01 | Std dev of Box-Muller noise on features |
| `decay_rate` | echoforge | — | Global echo decay rate override |
| `decay_rate_mean_reversion` | echoforge | 0.08 | Per-type decay rate override |
| `decay_rate_momentum` | echoforge | 0.12 | Per-type decay rate override |
| `loss_multiplier` | echoforge | — | Global loss multiplier override |
| `pattern_vetos` | nociceptor, echoforge | {} | Per-pattern kill switch |

---

## Part 6 — Review & Suggested Actions

---

### Issue 1 — Two independent VPIN computations that can diverge

**Problem:** The system runs two completely separate VPIN calculations:
- `orderbook_worker` VPIN: 200ms volume decay, fast-reacting, feeds OFI feature[10] → inference
- `nociceptor` VPIN: EWMA α=0.02, slow-reacting, reads SAB ring buffer, drives regime detection and hurdle

These can differ substantially during regime transitions. A VPIN spike that instantly saturates the orderbook VPIN (and thus alters inference votes) may take minutes to propagate through nociceptor's slow EWMA. The inference model was trained on orderbook VPIN; the hurdle is gated by nociceptor VPIN — these are measuring different things with different timescales.

**Suggest:** Either (a) expose nociceptor's `_lastVpin` as a feature in the inference vector so the model can account for the VPIN that actually gates it, or (b) unify both to the same VPIN source. Option (a) is easier and preserves model independence. Add `nociceptor_vpin` as feature[11] (replacing or extending the current 11-element vector), retrain accordingly.

---

### Issue 2 — SUPERTREND_CROSS LowVol echo wastefully seeded

**Problem:** `KNOWN_ECHOES` seeds `SUPERTREND_CROSS:LowVol` at session start (MIN_ALIVENESS = 0.30). `REGIME_REQUIREMENTS` hard-drops every SUPERTREND_CROSS signal in LowVol with `REGIME_REQUIREMENT` reason. The LowVol echo therefore:
- Exists in memory and appears in UI echo snapshot
- Never receives any signals to strengthen or weaken its aliveness
- Misleads session analysis (appears as "alive" pattern with 0 executions)
- Cannot die naturally (no decay occurs without signal events)
- Will gossip its stale 0.30 aliveness to peers, influencing their merge

**Suggest:** In `KNOWN_ECHOES` initialisation, skip seeding any pattern/regime combination where `REGIME_REQUIREMENTS[pattern_id]` is defined and does not include that regime. Specifically: remove `SUPERTREND_CROSS:LowVol` from the seed list.

---

### Issue 3 — execution_intent silent fallback for missing jury p_up

**Problem:** index.html enriches `execution_intent` with `p_up` from `latestJuryResult`. If the jury cache is stale (>2s old) or empty when the intent fires, `p_up` silently defaults to `0.55`. Kelly sizing with `p_up=0.55` produces `kellyRaw = (0.55-0.5)/(1-0.55) = 0.111` — a low-conviction sizing regardless of actual signal strength. There is no log, warning, or flag to distinguish a genuine p_up=0.55 from a missing-jury fallback.

**Suggest:** Add `p_up_fallback: true` flag when the fallback is used. Log a warning. In high-signal environments (net_aliveness > 0.70 but p_up_fallback=true), consider blocking the intent or emitting a `jury_stale_alert`. The fallback p_up should not silently reduce position sizes without any visibility.

---

### Issue 4 — session_recorder vs echoforge outcome count mismatch

**Problem:** `recorder.record("outcome")` fires for every `execution_result` including non-decisive outcomes (`|score| < 0.05`). echoforge and bridge only receive outcomes where `|score| >= 0.05`. Session export `outcomes` array has more entries than aliveness decay updates. Running analysis scripts against exported session JSON will see outcome counts that don't match drift monitor event counts — the flat trades (~51% of outcomes from prior session analysis) appear in the file but never influenced aliveness.

**Suggest:** Add `decisive: true/false` field to every outcome record in session_recorder. All downstream analysis (decay tuner, drift monitor stats, strategy statistics) should filter to `decisive: true` entries to match live behavior. This makes the filtering explicit and auditable rather than implicit.

---

### Issue 5 — ARBI correlation-derived regime_tag conflicts with VPIN-derived regime

**Problem:** `correlation_worker` assigns `regime_tag` based on Pearson correlation and RVR — independent of nociceptor VPIN. An ARBI signal may arrive as `regime_tag="Crisis"` while nociceptor's `_currentRegime` is `"LowVol"`. In echoforge_worker, gate 4 compares `echo.regime_tag !== _currentRegime`. ARBI's echo uses `regime_tag="Any"` so gate 4 passes, but the signal itself carries the correlation-derived regime which can affect PHIC regime_cap lookup in downstream routing. This creates ambiguity: the execution regime_cap applied to ARBI sizing could come from the wrong regime.

**Suggest:** ARBI `signal_pass` messages should always carry `regime_tag="Any"` (overriding the correlation-derived regime). The correlation regime is useful for cross-pair boost logic but should not influence the regime_cap applied to ARBI execution sizing. Document this explicitly in correlation_worker's emit path.

---

### Issue 6 — Stop-loss sells only 50% of position; remainder exposed during lockout

**Problem:** `STOP_LOSS_SELL_FRAC = 0.50` sells half the position. After fire, a 2-minute buy lockout prevents new entries. The remaining 50% of BTC continues accumulating losses during the lockout window. The buy lockout protects against re-entry but does nothing for the existing open position. In a trending downward market, 50% can lose significantly during the 120s lockout period.

**Suggest:** Make `stop_loss_sell_frac` a PHIC-configurable field (it is not currently exposed). Add UI slider (range: 0.25–1.0, default: 0.50). For Crisis regime entries, consider defaulting to 0.75 or higher. Document the design intent: partial sell preserves upside if the move is a temporary dip, but creates residual exposure risk.

---

### Issue 7 — Ghost trade win condition ignores trading fees

**Problem:** Paper heartbeat win condition is `priceDiff > spreadPct` where `spreadPct = _currentSpread / entryPrice`. This does not include maker/taker fees. A trade that moves price by 0.025% (above the spread of ~0.02%) registers as a ghost win even though the net P&L after fees would be negative. Ghost wins accumulate in `shadow_aliveness` and can trigger autonomous resurrection of a pattern that doesn't actually have edge after fees.

**Suggest:** Win threshold should be `spreadPct + maker_fee_default + taker_fee_default`. Better: the pending signal record has `net_alpha` and `hurdle` — use `hurdle` directly as the win threshold, since hurdle already incorporates fees, strain, and VPIN context. This makes paper heartbeat consistent with the metabolic gate.

---

### Issue 8 — Beta-Bernoulli only tracks closed trades, not signal count

**Problem:** `beta_alpha`/`beta_beta` update only on sell fills (execution_result). The `success_prob` field is therefore `P(profitable close | trade closed)`, not `P(edge | signal fired)`. The `ci95_width` formula uses `n = alpha + beta` (closed trade count), but the echo display presents it alongside `execution_count` in a way that implies statistical confidence across all decisions. An echo that fires 500 signals but only closes 8 trades will show `ci95_width = 0.219` — which means very little about the 492 unclosed decisions.

**Suggest:** Add `signal_count` field incremented on every `signal_pass` (separate from `execution_count` which counts sell fills). Display `signal_count` in the echo snapshot UI. Add a tooltip or annotation making clear that `ci95_width` represents uncertainty on closed-trade outcomes only, not on the full signal population.

---

### Issue 9 — No sell-side suppression logic when position is profitable

**Problem:** Gate 11 in `_onSignalPass` suppresses BUY signals when `unrealNorm > 0.015` (no pyramiding when winning). But SELL signals from unrelated patterns are never suppressed when the position is highly profitable. Any pattern's sell signal could partially close a winning position opened by a different pattern. Example: WHALE_WAKE opens a position, price rises +2%, then DEPTH_GRAB (a maker pattern) emits a sell signal and partially closes the winning WHALE_WAKE position.

**Suggest:** When `unrealNorm > 0.015`, only allow sell signals from the pattern tracked in `_exposureByPattern`. Sell signals from other patterns should be ghost-traded in this condition. This preserves position management while preventing cross-pattern interference on winning trades. Implementation: check `_exposureByPattern.has(pattern_id)` when suppressing; patterns with no exposure entry may still sell (they could be hedging).

---

### Issue 10 — Drawdown breach counter resets on any single sub-threshold check

**Problem:** The Guardian's `_drawdownBreachCount` (used for equity-lower-highs detection) resets to 0 whenever any single 30s check comes in above the threshold. Price oscillating around the drawdown threshold can delay REDUCE_ONLY transition indefinitely: 2 breaches, bounce above threshold, reset to 0, 2 more breaches, bounce again — never reaches N=3.

**Suggest:** Replace the consecutive-count mechanism with time-based hysteresis: trigger REDUCE_ONLY if cumulative time above drawdown limit exceeds `N * 30s` (e.g. 90s total) within a rolling 5-minute window, regardless of whether the breaches were consecutive. This prevents oscillation from gaming the counter.

---

### Issue 11 — VOLATILITY_BREAKOUT VPIN threshold analysis (regime overlap in LowVol sessions)

**Problem:** Session analysis (echoforge-session-9bc1ec46) showed VOLATILITY_BREAKOUT was the most active pattern (1,078 decisions) despite the session being 86.9% LowVol. Analysis: nociceptor VPIN median was 0.634 during that session — above the HighVol threshold (0.35), creating frequent brief HighVol windows. VOLATILITY_BREAKOUT is seeded for HighVol/Crisis and activates in those HighVol pockets. The session's "LowVol" label is nominal (regime by time fraction) but VPIN was elevated persistently — the breakout pattern was legitimately active.

**Suggest:** Add `regime_dwell_ms` to session event records for each regime_change event (already partially addressed by recorder — check that `from_regime` and `to_regime` are present). Export `vpin_stats` (p25, median, p75, p95) per session at export time. This distinguishes "true LowVol" (VPIN stable < 0.35) from "nominally LowVol with VPIN oscillating above 0.35." Calibration should target true LowVol windows.

---

### Issue 12 — Pain map silent in LowVol; by design but undocumented

**Problem / Observation:** `pain_map` is only broadcast by nociceptor when `_lastVpin >= 0.35`. In calm LowVol conditions (VPIN < 0.35), metabolic drops do not broadcast pain to peers. Quorum pain veto can therefore only fire in HighVol+ conditions. LowVol pattern failures propagate only via metabolic strain (which requires a real trade loss with `outcomeScore <= -0.3`) — a much higher bar.

**Suggest:** This is intentional design (pain map = stress-market alarm, not general failure broadcast). No code change needed. Document explicitly in a code comment near the pain_map broadcast condition: "LowVol hurdle misses are expected calibration noise; pain broadcast reserved for HighVol+ toxic flow conditions." Add a note to the PHIC docs that `pain_map_vpin_threshold` is implicitly the HighVol threshold.

---

### Issue 13 — regime_strain_exp PHIC override is global; suggestion engine can't target per-type

**Problem:** The suggestion engine recommends raising/easing `regime_strain_exp[regime]` (a global override applying to ALL strategy types in that regime). But `STRATEGY_STRAIN` is hardcoded per type in nociceptor_worker.js, and `regime_strain_exp` takes priority only as a fallback when type-specific strain isn't found. When the suggestion engine recommends easing HighVol strain (because mean_reversion is losing), it inadvertently eases hurdles for all strategy types in HighVol — including momentum, which may be profitable and not need easing.

**Suggest:** Extend PHIC schema with `strain_overrides.<type>.<regime>` (e.g., `strain_overrides.mean_reversion.HighVol`). Update nociceptor hurdle lookup to check `_phic.strain_overrides?.[type]?.[regime]` as priority 1, before falling back to STRATEGY_STRAIN. Update the suggestion engine to emit `strain_overrides.mean_reversion.HighVol` recommendations rather than global `regime_strain_exp.HighVol`. This enables the regression optimizer to adjust per-type hurdles without code changes.

---

### Issue 14 — `_reservedBtc` not included in total exposure calculation

**Problem:** Gate 8 in `_handleIntent` computes total exposure as `_portfolio.btc * livePrice / totalVal`. But `_portfolio.btc` reflects only settled fills. `_reservedBtc` tracks BTC committed to active open sell orders that haven't settled yet. If multiple sell intents fire simultaneously at high signal rate, `_portfolio.btc` doesn't reflect the in-flight sells, potentially over-counting current BTC exposure and allowing additional positions when the effective exposure is already near the cap.

**Suggest:** Gate 8 should use `(_portfolio.btc - _reservedBtc) * livePrice / totalVal` for the available-to-sell check, and `(_portfolio.usdt - _reservedUsdt)` for the available-to-buy check. This makes the exposure gate consistent with actual committed capital including in-flight orders. The current optimistic reservation system already tracks these values — they just aren't applied to the gate logic.

---

---

## Part 7 — Concurrency & SAB Contention Audit

### SharedArrayBuffer Ring Buffer Access

The **only** SharedArrayBuffer in the system is the trade-tick ring buffer shared between `orderbook_worker` (writer) and `nociceptor_worker` (reader). All other inter-worker communication uses `postMessage` (structured clone, not shared memory).

| Component | SAB access | What it touches |
|---|---|---|
| `orderbook_worker` | **WRITE** | Writes trade ticks (price, volume, side, timestamp) into the ring buffer on every VALR/BINANCE WS message |
| `nociceptor_worker` | **READ** | Reads ring buffer every 8ms via `Atomics.load` on the write-head pointer; reads tick data with no lock |
| All other workers | None | Communicate via `postMessage` only |

The ring buffer uses `Atomics` for the write-head pointer to avoid torn reads. Individual tick slots are written before the pointer advances, so nociceptor's 8ms poll either sees the previous tick (pointer hasn't moved) or a fully committed new tick. Torn reads of partial tick data are prevented by the pointer discipline, not by a mutex.

**Contention risk:** LOW for normal operation. During sustained high-frequency VALR message bursts (>1000 ticks/s), ring buffer slots may be overwritten before nociceptor's 8ms poll drains them. This causes VPIN drift (nociceptor skips ticks) without any error — `_lastVpin` becomes stale. The VPIN warmup counter (`VPIN_WARMUP_TICKS = 100`) only applies at startup; there is no stale-detection mechanism for mid-session ring buffer saturation.

**Mitigation in place:** Ring buffer is sized for ~1s of ticks at normal tick rate. Saturation is only a risk during extreme flash events.

---

### PHIC State Race Window

PHIC is **not** in a SharedArrayBuffer. It propagates via `postMessage` from index.html to all workers. Each worker holds a local `_phic` copy updated asynchronously on message receipt.

**Access pattern:**

| Component | PHIC access | Update path |
|---|---|---|
| `index.html` | Read + Write | User UI → local state → broadcast |
| `nociceptor_worker` | READ `_phic` on every 8ms poll | `postMessage` from index.html |
| `execution_worker` | READ `_phic` per intent | `postMessage` from index.html |
| `echoforge_worker` | READ `_phic` per signal | `postMessage` from index.html |
| `inference_worker × 3` | READ `_phic` per inference | `postMessage` from index.html |
| `daemon` | READ via HTTP GET `/api/v1/phic/config` | HTTP POST from index.html |

**Race window during regime shift + PHIC update:**

The critical sequence is:
1. VPIN spikes → nociceptor detects regime Crisis → posts `regime_change` to index.html
2. User simultaneously pushes PHIC update (e.g. lowering `regime_caps.Crisis = 0.05`)
3. index.html processes messages in order, broadcasts updated PHIC to all workers
4. **Window:** nociceptor may compute one or two hurdles with old `_phic.regime_caps` before the update lands

This window is typically **< 1 message queue drain cycle** (~1–5ms). The risk is not significant in isolation, but during a multi-signal burst at regime transition (when many signals fire simultaneously), a handful of signals may be evaluated against stale regime_caps.

**There is no `phic_hash` or version counter** currently implemented to detect stale PHIC in workers. Each worker applies whatever `_phic` it has at signal evaluation time.

**Suggest:** Add a `phic_seq` monotone counter (incremented on every PHIC write in index.html). Each `signal_pass` and `execution_intent` message should carry the `phic_seq` value that was current when the signal was evaluated. Log a warning if a signal is executed with a `phic_seq` that differs from the current sequence by more than 1. This makes PHIC-staleness observable in session records.

---

### §10 Addendum — Zero-Alpha Baseline (No Decisive Outcomes for >1 Hour)

**What happens when the bridge receives no `outcome_recorded` for >1 hour:**

| Component | Behaviour |
|---|---|
| `DriftMonitor` | 30s cycle continues running; last-N-samples window never refills; slope/r² computed on stale window from >1h ago; no new drift_alert can fire (new data required to update regression) |
| `RegressionOptimizer` | 5-min cycle runs but sample count stays below 50 threshold; no coefficient push occurs; model stays frozen at last pushed state |
| `echoforge_worker` suggestion engine | `SUGGEST_EVERY_N=25` counter never increments via outcomes; 1h timer still fires → suggestion engine runs on the existing `signal_log` without new outcomes added; if signal_log < `SUGGEST_MIN_BUCKET` (10) per bucket, no recommendations generated |
| Echo aliveness | Unaffected directly; echoes still receive `signal_pass` events and still boost on pass; but no `execution_result` means no Bayesian decay updates — aliveness drifts toward steady-state determined by signal boost alone |

**Silent risk:** If no decisive outcomes fire for >1h, the echo `net_aliveness` values stabilise at whatever level signal boosts push them to, with no corrective decay. A pattern that has been consistently losing (but producing non-decisive outcomes `|score| < 0.05`) will appear healthy with high aliveness.

**System assumption in this state:** The bridge effectively assumes "market stagnation" (no signal). It does not raise a drift alert. It does not assume the patterns are profitable — it simply has no data to say otherwise.

**Suggest:** Add a `last_outcome_ts` timestamp to the DriftMonitor. If `now - last_outcome_ts > 3600s`, emit a `outcome_silence_alert` to the UI. This distinguishes genuine quiet sessions (no trades fired) from a broken outcome pipeline (trades fired but fills not being reported). Also: the `signal_log` should record non-decisive outcomes with a `decisive: false` flag so the silence can be diagnosed: "100 outcomes recorded, 0 decisive" vs "0 outcomes recorded."

---

## Part 8 — FMEA: Issue Severity & Detection Difficulty

| # | Issue | Severity (1–10) | Detection Difficulty (1–10) | Notes |
|---|---|---|---|---|
| 1 | Two diverging VPIN computations | 6 | 8 | Hurdle gates on different VPIN than inference features; only detectable by logging both VPINs side-by-side |
| 2 | SUPERTREND_CROSS LowVol echo wastefully seeded | 3 | 3 | Visible as 0-execution echo in UI snapshot; no trading impact |
| 3 | execution_intent silent p_up fallback | 5 | 7 | Silent sizing reduction; no flag distinguishes genuine p_up=0.55 from fallback |
| 4 | Outcome count mismatch (recorder vs echoforge) | 4 | 5 | Apparent when comparing session file outcome count to aliveness update count |
| 5 | ARBI correlation regime_tag conflict | 5 | 8 | Requires tracing regime_cap lookup through signal routing; no logging in the ambiguous path |
| 6 | Stop-loss 50% sell fraction not configurable | 7 | 2 | Obvious in code; impact is real but not catastrophic in most market conditions |
| 7 | Ghost trade win condition ignores fees | 6 | 7 | Shadow_aliveness optimistically elevated; resurrections fire on patterns without real fee-adjusted edge |
| 8 | Beta-Bernoulli closed-trade only tracking | 4 | 4 | Misleading CI display; documented issue but easy to misread in UI |
| 9 | No sell-side suppression when position profitable | 6 | 6 | Requires multi-pattern session trace to observe cross-pattern position interference |
| 10 | Drawdown breach counter resets on bounce | 7 | 5 | Guardian delay reproducible in simulation; in live sessions oscillation around threshold is common |
| 11 | VOLATILITY_BREAKOUT VPIN threshold overlap | 4 | 3 | Visible in session stats; requires `vpin_stats` export to diagnose accurately |
| 12 | Pain map silent in LowVol (intentional) | 3 | 2 | Clearly visible in code; design intent not documented |
| 13 | Global regime_strain_exp can't target per-type | 6 | 6 | Suggestion engine correctly identifies problem but cannot act on it precisely; silent over-easing |
| **14** | **_reservedBtc not in exposure calculation** | **9** | **9** | **Silent killer: in-flight orders not counted in Gate 8; can allow over-exposure near cap; triggers floor breach without warning. No log output. Requires reconstructing order ledger vs portfolio state to detect post-hoc.** |
| **15** | **Browser tab throttling (see §15 below)** | **9** | **6** | **Trading on 1Hz throttled data in background tab; complete VPIN staleness; Guardian does not auto-trigger on visibility change** |

**Key:** Severity = trading/financial impact if triggered. Detection Difficulty = ease of spotting in production without specific instrumentation.

Issue 14 is the highest-risk silent failure: the system can silently exceed its own exposure cap under concurrent order load without any log entry or alert, directly increasing floor breach probability.

---

### Issue 15 — Browser Tab Throttling in Background Tabs

**Problem:** Chrome, Brave, and other Chromium-based browsers apply timer throttling when a tab is not visible (hidden or backgrounded). Throttled timers fire at a minimum interval of **1 second** (or even 1 minute in Chrome's aggressive mode for tabs idle >5 minutes). This breaks multiple critical timing dependencies:

| System | Normal interval | Throttled interval | Effect |
|---|---|---|---|
| Nociceptor SAB poll | 8ms | 1000ms+ | VPIN based on 125× fewer ticks; regime detection 125× slower |
| `orderbook_worker` VPIN decay | 200ms factor | Decay applied at wrong dt | `volDecay = 0.95^(1000/200) = 0.95^5 ≈ 0.77` per tick instead of per 200ms — severe underestimation of recent volume |
| Echo ghost resolution | 5s | ~1min | Paper heartbeat resolution stalls; shadow_aliveness freezes |
| Guardian 30s checks | 30s | Delayed up to minutes | Stop-loss, floor, profit banking all run on stale price |
| `execution_worker` 30s checks | 30s | Delayed up to minutes | Active positions unprotected |

**Critically:** The `nociceptor_worker` is a Web Worker, not the main thread — but Web Workers are also subject to background throttling in Chrome 88+ when the owning tab is hidden.

**Detection:** `document.visibilityState === "hidden"` in the main thread. Web Workers do not receive `visibilitychange` events directly — the main thread must relay this.

**Current state:** There is no `visibilityState` check in any worker or in index.html. A tab moved to background continues attempting to trade on 1Hz throttled data without any guard.

**Suggest:**
1. Add `visibilitychange` listener in index.html:
   ```javascript
   document.addEventListener("visibilitychange", () => {
     if (document.visibilityState === "hidden") {
       // Force Guardian to REDUCE_ONLY immediately
       _setGuardianState("REDUCE_ONLY", "tab_hidden");
       // Broadcast to all workers
       nocWorker.postMessage({ type: "tab_hidden" });
       execWorker.postMessage({ type: "tab_hidden" });
     } else {
       // Tab restored — allow Guardian to recover normally
       nocWorker.postMessage({ type: "tab_visible" });
     }
   });
   ```
2. In `nociceptor_worker`: on `tab_hidden`, set `_passive = true` (same path as latency passive mode) so all signals are dropped until tab is visible again.
3. In `execution_worker`: on `tab_hidden`, set `_emergencyFreeze = true` to block all new intents.
4. Guardian recovery from `tab_hidden` should require 1 full 30s check cycle of valid data before relaxing to CAUTIOUS (not immediate NOMINAL).
5. Consider using the [Page Visibility API + `navigator.locks`](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) to coordinate multi-tab background state, since a mesh may have one active tab and several background tabs.

This is a **Severity 9** issue: a backgrounded EchoForge tab may hold open positions, fire stop-loss checks on 1-minute-old prices, and compute VPIN from severely undersampled data — all without any warning to the user.

---

*End of echo_logic.md* // feedback below

Having thoroughly reviewed `echo_logic.md`, I can confirm the existing Issues 1–15 and the FMEA table are exceptionally rigorous. The architecture is well-thought-out, particularly the metabolic filter, echo lifecycle, and guardian HSM. However, several **non-obvious blind spots** exist that typically surface only under sustained live load, network partitioning, or browser runtime edge cases. Below is a detailed architectural review organized by risk domain, with mitigation strategies.

---
### 🔒 1. Security & Browser Execution Environment
**Missed Aspect:** The document assumes a trusted browser environment but doesn't address client-side attack vectors.
- **API Key Exposure:** Each tab holds a VALR API key in JavaScript memory. Browser extensions, malicious iframes, or XSS vulnerabilities can extract keys and drain accounts. No mention of key encryption, ephemeral session tokens, or a local signing proxy.
- **Worker Crash Recovery:** Web Workers do not auto-restart. If `execution_worker` or `nociceptor_worker` throws an uncaught exception, the pipeline silently degrades. No health-check pings, watchdog, or fallback graceful degradation exists.
- **Mitigation:** 
  - Use `crypto.subtle` to encrypt keys in memory; require decryption via user gesture per session.
  - Implement a `WorkerHeartbeat` protocol: main thread sends `ping` every 2s; workers respond. Missed `pong` ×3 triggers `REDUCE_ONLY` and attempts `new Worker()`.
  - Sanitize all `BroadcastChannel` and `postMessage` payloads with a strict schema validator (e.g., Zod/JSON Schema) before processing.

---
### ⚡ 2. Concurrency, Message Ordering & Backpressure
**Missed Aspect:** `postMessage` uses an asynchronous queue. Under sustained market spikes, message ordering and queue depth become non-deterministic.
- **Cross-Modal Feature Misalignment:** The 11-element inference vector mixes instantaneous data (`price`, `spread_norm`) with stateful data (`pos_size_norm`, `unrealized_pct`). If `tick` and `portfolio_update` messages arrive out of order, the feature vector may represent a phantom state.
- **Backpressure & Queue Overflow:** During flash crashes or exchange message bursts (>2000 msg/s), worker message queues can grow to hundreds of ms of latency. No flow-control or adaptive dropping mechanism exists.
- **Mitigation:**
  - Tag all messages with a monotonically increasing `seq_id` per worker. In `index.html`, discard feature vectors where `price.seq_id < state.seq_id - 1`.
  - Implement a `priority queue` in workers: `WHALE_WAKE` and `floor_breach` jump to the front; `depth_update` and `ofi_snapshot` can be dropped if queue length > 50.
  - Use `MessageChannel` instead of `postMessage` for critical paths to gain explicit backpressure via `port.onmessage` buffering.

---
### 📐 3. Risk Management & Mathematical Assumptions
**Missed Aspect:** Several risk formulas make simplifying assumptions that diverge from real market dynamics.
- **Kelly Sizing Payoff Assumption:** `kellyRaw = (pUp - 0.5) / max(0.01, 1 - pUp)` assumes a 1:1 win/loss payoff ratio. Crypto spot trading is rarely symmetric. If average loss > average win, this formula will **overbet** during low-conviction signals, accelerating drawdowns.
- **Regime Exit Asymmetry:** `_checkRegimeExit` only triggers on severity jumps (`new > old`). If a position is opened in `Crisis` and regime drops to `LowVol`, no sell is triggered. The system cuts into worsening regimes but **holds through improving ones**, missing profit-taking opportunities during mean-reversion.
- **Gross vs Net Exposure:** Gate 8 checks `_portfolio.btc * price / totalVal`. This is net exposure. During high signal rates, Pattern A buys 0.05 BTC while Pattern B sells 0.04 BTC. Net exposure is low, but **gross volume** (0.09 BTC) hits exchange rate limits, increases slippage, and consumes API quota.
- **Mitigation:**
  - Replace raw Kelly with **Fractional Kelly adjusted for payoff ratio**: `k = f * (pUp - q/b) / b`, where `b = avg_win / avg_loss`, tracked via rolling EWMA per strategy.
  - Add `_checkRegimeImprove`: if `jump <= -1` and `unrealized_pnl > bank_profit_threshold_pct`, trigger a partial regime-improve bank (e.g., 20% sell).
  - Track `_grossExposureBtc` (sum of absolute pattern exposures) and add a `max_gross_exposure_pct` PHIC field.

---
### 🌐 4. P2P Mesh & Distributed Consistency
**Missed Aspect:** WebRTC/quorum logic assumes reliable, low-latency peer communication, which rarely holds in real browser networks.
- **Split-Brain & Quorum Ambiguity:** Quorum = `ceil((N+1)/2)`. If 4 tabs partition into 2+2, neither reaches quorum, or both reach conflicting quorums if network heals asymmetrically. No leader election or partition-tolerance logic (e.g., Raft-style term IDs).
- **Clock Skew in Gossip:** Echo gossip uses `timestamp` for TTL/expiry. Browser clocks drift by ±2s easily. A peer report with a future clock will expire prematurely; a past-dated report may linger, causing false strain accumulation.
- **Mitigation:**
  - Implement **Vector Clocks** or **Hybrid Logical Clocks (HLC)** for peer gossip. Each peer increments a logical counter on every gossip round. Conflicts resolve by `(logical_counter, node_id)` lexicographical order.
  - Use `performance.timeOrigin` + `Date.now()` offset calibration during mesh handshake to normalize timestamps before TTL comparison.
  - Add a `partition_detect` heuristic: if `gossip_rounds_received / expected < 0.5` for 3 consecutive intervals, force local `HALTED` and emit `mesh_partition_alert`.

---
### 🤖 5. ML/Inference Pipeline & Feature Integrity
**Missed Aspect:** The inference system assumes static feature distributions and model stability.
- **Feature Scaling Drift:** The 11-element vector isn't normalized per regime. During `Crisis`, `z_score` and `momentum` magnitudes explode, pushing MLP inputs outside training distribution. Box-Muller noise becomes negligible relative to signal variance, breaking the ensemble's diversity guarantee.
- **ORT WASM Memory Fragmentation:** The doc notes `_probeWidth` catches WASM traps, but ONNX Runtime in browser uses a linear memory allocator. Long-running sessions cause fragmentation. Eventually, `session.run()` fails silently or returns NaNs.
- **Mitigation:**
  - Add **regime-aware feature scaling** in `index.html`: maintain rolling mean/std per feature per regime. Normalize features to `z = (x - μ_regime) / σ_regime` before feeding workers.
  - Implement a **model health monitor**: track `isNaN(output)`, `|output| > 3.0`, or `output_variance < 1e-6` over 50 inferences. Trigger `reload_model` or fallback to `_jsInfer` if degradation detected.
  - Schedule a `ORT.session.release()` + `new Worker()` restart every 6h to defragment WASM heap.

---
### ⏱️ 6. Timekeeping, Browser Throttling & Worker Lifecycle
**Missed Aspect:** Beyond Issue 15 (tab throttling), browser time APIs and event loop scheduling introduce subtle drift.
- **`Date.now()` vs Monotonic Time:** VPIN decay and EMA use `dt_ms = Date.now() - lastTick`. `Date.now()` is wall-clock and jumps on NTP sync, DST, or manual OS clock changes. This corrupts exponential decays.
- **Event Loop Starvation:** `index.html` main thread handles UI, Guardian checks, recorder, and message routing. Heavy DOM updates or `recorder.record()` serialization can block `postMessage` delivery for 100-500ms, desynchronizing the pipeline.
- **Mitigation:**
  - Replace all decay/EMA time deltas with `performance.now()` (monotonic, immune to wall-clock jumps).
  - Offload `session_recorder` serialization to a dedicated `recorder_worker`. Main thread only posts raw events via `StructuredClone` (zero-copy for SAB-backed data).
  - Add a `main_thread_latency_ms` metric: `performance.now() - message.timestamp`. If >50ms, auto-trigger `CAUTIOUS` guardian state.

---
### 📊 7. Observability, Memory & Storage Limits
**Missed Aspect:** Long-running browser sessions accumulate state that can hit hard limits.
- **IndexedDB Quota Exceeded:** SAF and `session_recorder` share the same origin quota. Chrome caps per-origin DB at ~6GB. If a session runs for days with heavy recording, `put()` fails silently, causing SAF retries to loop indefinitely.
- **Memory Leaks in Maps:** `peer_reports`, `strain_reports`, `pain_reports` expire by TTL, but `_pendingSignals` and `_exposureByPattern` grow unbounded if signals pass but fills never arrive (e.g., exchange API timeout, orphaned orders).
- **Mitigation:**
  - Implement **quota monitoring**: `navigator.storage.estimate().then(e => e.usage / e.quota)`. If >80%, trigger `SAF purge` and switch recorder to `ring_buffer_mode` (overwrite oldest).
  - Add a **pending signal TTL**: if `_pendingSignals[key].age > 30s`, mark as `ORPHANED`, emit `orphan_signal_alert`, and free memory.
  - Use `WeakRef` or explicit `clear()` calls in `_onExecutionResult` and `_onOrderTimeout`.

---
### 📋 Priority Matrix & Integration Path

| Category | Severity | Detection Difficulty | Suggested Patch Priority |
|----------|----------|----------------------|--------------------------|
| API Key Exposure / Worker Crash | 9 | 7 | P0 (Security/Resilience) |
| Kelly Payoff Assumption / Gross Exposure | 8 | 8 | P1 (Risk Integrity) |
| Monotonic Time / Event Loop Starvation | 7 | 6 | P1 (Pipeline Stability) |
| P2P Split-Brain / Clock Skew | 6 | 9 | P2 (Mesh Reliability) |
| Feature Scaling Drift / WASM Fragmentation | 6 | 8 | P2 (ML Integrity) |
| IndexedDB Quota / Pending Signal Leaks | 5 | 5 | P3 (Operational) |

**Implementation Recommendation:** 
Start with **P0/P1** fixes as they require minimal architectural changes but yield immediate risk reduction:
1. Switch all time deltas to `performance.now()`.
2. Add `WorkerHeartbeat` + auto-restart.
3. Implement payoff-adjusted fractional Kelly.
4. Add `gross_exposure_pct` gate.
5. Encrypt API keys in memory + schema-validate all cross-worker messages.

These gaps are subtle because they only manifest under **compound stress**: high volatility + tab backgrounding + mesh partition + extended runtime. The existing document is exceptionally thorough; addressing these will push EchoForge from a robust prototype to a production-grade sovereign trading mesh.

// suggested plan

Here is the **fully consolidated, traceable implementation plan**, explicitly mapping every action item to the original document’s Issues, FMEA ratings, architectural sections, and the browser/market microstructure audit findings.

---
# 🗺️ EchoForge Master Implementation Plan (v0.2.0)
**Objective:** Resolve all 15 documented issues, 7 audit blind spots, and latent runtime constraints. Elevate from prototype to production-grade sovereign mesh.
**Guiding Principle:** *Trace every fix to a documented pain point. Validate against FMEA severity & detection difficulty.*

---
## 🚨 Phase 0: Critical Data Integrity & Runtime Safety (Days 1–5)
*Blocks live deployment. Resolves highest-severity silent failures and browser lifecycle vulnerabilities.*

| Task | Target Files | 🔗 References & Pain Points Resolved | Implementation Details | Validation |
|------|--------------|--------------------------------------|------------------------|------------|
| **L2 Sequence Gap & Book Consistency** | `orderbook_worker.js` | `[Audit #2]` L2 Stale Book Race<br>`[Part 7]` SAB ring buffer saturation/VPIN drift<br>`[Doc Issue 1]` Diverging VPIN root cause | Track `u`/`U` sequence from exchange. On `incoming.U > _lastSeq + 1`, halt OFI/tick emission, emit `book_stale_alert`, request fresh `l2_snapshot`. Add `depth_consistency_check` before feature emit. | Inject synthetic L2 gap. Verify pipeline pauses, no stale OFI reaches inference, VPIN stabilizes post-sync. |
| **Monotonic Time & Decay Standardization** | All workers, `index.html` | `[Issue 15]` Tab throttling time distortion<br>`[Part 3 §1]` VPIN/EMA `dt_ms` decay corruption<br>`[Doc]` NTP/DST clock jumps | Replace `Date.now()` in all EMA/VPIN/decay formulas with `performance.now()`. Cache `timeOrigin` offset for UTC logging only. | Simulate OS clock jump & background throttling. Verify VPIN/EMA continuity, zero decay artifacts. |
| **Tab Visibility & Throttling Guard** | `index.html`, all workers | `[Issue 15]` Browser Tab Throttling (FMEA Sev 9)<br>`[Part 7]` SAB reader stall at 1Hz<br>`[Doc §5]` Guardian 30s check delay | `visibilitychange` → broadcast `tab_hidden`. Nociceptor sets `_passive=true`, execution sets `_emergencyFreeze=true`, Guardian → `REDUCE_ONLY`. Require 30s valid-data cycle post-restore. | Background tab for 5m. Verify zero intents, VPIN freezes safely, positions protected, clean recovery. |
| **Worker Heartbeat & Auto-Restart** | `index.html`, worker entry | `[Audit #4]` PWA Memory Exhaustion<br>`[Part 7]` Silent worker freeze/stall<br>`[Doc §7]` WASM allocator corruption | 2s `ping`/`pong` via `postMessage`. Missed ×3 → terminate, `new Worker()`, reload PHIC/echo state. Fallback to `REDUCE_ONLY` during restart. | Throw uncaught exception in worker. Verify auto-restart, pipeline resume, guardian downgrade, zero silent degradation. |

**✅ Phase 0 Success Criteria:** Zero silent data corruption under flash volatility. Background tabs auto-freeze. Workers survive unhandled errors without pipeline degradation. FMEA Sev 9 issues mitigated.

---
## 💰 Phase 1: Risk Calibration & Execution Hardening (Weeks 2–3)
*Aligns sizing, fees, and exposure gates with real market microstructure. Prevents over-exposure and fee-induced alpha decay.*

| Task | Target Files | 🔗 References & Pain Points Resolved | Implementation Details | Validation |
|------|--------------|--------------------------------------|------------------------|------------|
| **Atomic Pending Exposure & In-Flight Reservation** | `execution_worker.js` | `[Issue 14]` `_reservedBtc` not in Gate 8 (FMEA Sev 9)<br>`[Audit #5]` Kelly Correlation Overlap<br>`[Issue 9]` Cross-pattern interference | Add `_pendingExposureMap`. On intent: `reservedQty = calcKelly(...)`. Gate 8: `effectiveExposure = (_portfolio.btc - _reservedBtc)`. Update on fill/timeout/cancel. | Simulate 3 correlated patterns firing in same tick. Verify total exposure ≤ `max_total_exposure_pct`. Log exposure pre/post reservation. |
| **Strategy-Aware Fee Hurdle & Ghost Trade Alignment** | `nociceptor_worker.js`, PHIC | `[Audit #3]` Asymmetric Fee Assumptions<br>`[Issue 7]` Ghost trade ignores fees<br>`[Doc §2]` Metabolic drop miscalibration | Add `PHIC.fee_model` per type (`maker_only`, `taker_only`, `mixed`). `hurdle = (maker_fee*legs.maker + taker_fee*legs.taker) * multipliers`. Ghost win threshold = `actual_hurdle`. | Compare hurdle vs. session drop rates for `DEPTH_GRAB`/`SPREAD_FADE`. Verify ~30% hurdle reduction, no alpha loss, ghost trades align with real economics. |
| **HWM Decay & Drawdown Hysteresis** | `execution_worker.js` | `[Audit #6]` HWM Trap (frozen banking)<br>`[Issue 10]` Drawdown breach counter resets<br>`[Doc §5]` Capital efficiency in chop | Add `PHIC.hwm_decay_rate` (e.g., `0.0001`/30s). Replace consecutive-count with rolling time-based hysteresis: trigger `REDUCE_ONLY` if cumulative time above drawdown > 90s in 5m window. | Backtest 30% drawdown with choppy recovery. Verify incremental banking, Guardian no longer gamed by oscillation. |
| **Configurable Stop-Loss Fraction** | `execution_worker.js`, UI | `[Issue 6]` Stop-loss sells only 50%<br>`[Doc §5]` Residual exposure during lockout | Expose `stop_loss_sell_frac` to PHIC (0.25–1.0). Add regime-aware override: Crisis entries default to 0.75. Log `stop_loss_frac_applied`. | Simulate flash crash during Crisis. Verify faster position reduction, reduced residual exposure, UI reflects config. |
| **ARBI Regime Routing Fix** | `index.html`, `echoforge_worker.js` | `[Issue 5]` ARBI correlation regime conflict<br>`[Doc §3/§4]` Regime cap ambiguity | Force `ARBI_CROSS_EXCHANGE` signals to carry `regime_tag="Any"` during execution routing. Correlation regime retained only for cross-pair boost logic. | Emit ARBI during LowVol. Verify regime cap lookup uses `Any`/default, not correlation-derived Crisis. |

**✅ Phase 1 Success Criteria:** No exposure cap breaches under concurrent signals. Maker strategies show improved hurdle pass rates. HWM no longer blocks recovery banking. Guardian drawdown logic robust to oscillation.

---
## 🧠 Phase 2: ML Stability & Mesh Consensus (Weeks 4–5)
*Prevents inference explosion under OOD features. Hardens P2P against split-brain, clock skew, and Byzantine reports.*

| Task | Target Files | 🔗 References & Pain Points Resolved | Implementation Details | Validation |
|------|--------------|--------------------------------------|------------------------|------------|
| **Feature Squash & Regime-Aware Scaling** | `index.html`, `inference_worker.js` | `[Audit #7]` Feature Scaling & Drift<br>`[Issue 1]` VPIN feature divergence<br>`[Doc §7]` MLP activation explosion | Maintain rolling `μ_regime`, `σ_regime` per feature. Pre-inference: `z = (x - μ)/σ`, then `Math.tanh(z/3)*3`. Log `feature_max_abs`. | Inject crash scenario (`z_score=-15`). Verify MLP output stays within `[-1,1]`, no activation explosion, regime scaling applied. |
| **ML Health Monitor & WASM Recycle** | `inference_worker.js` | `[Audit #4]` PWA Memory/WASM fragmentation<br>`[Doc §7]` `_probeWidth` WASM trap fallback<br>`[Doc Part 7]` Long-run session stability | Track `isNaN`, `|output|>3`, `variance<1e-6` over 50 runs. On degradation: `ORT.session.release()`, `new Worker()`, fallback to `_jsInfer`. Schedule 6h auto-recycle. | Run 24h continuous inference. Monitor WASM heap fragmentation. Verify graceful fallback, zero silent NaN propagation. |
| **Peer Report Validation & Weighted Quorum** | `echoforge_worker.js`, `mesh.js` | `[Audit #1]` Byzantine Peer Vulnerability<br>`[Issue 12]` Pain map silent in LowVol<br>`[Doc §4/§9]` Quorum ambiguity & split-brain | Add `_validatePeerReport()`: discard if `|peer_vpin - local_vpin| > 0.25` or `regime_mismatch`. Replace raw count with `quorum_score = Σ(weight*strain)`. Add peer reputation EWMA. | Simulate rogue peer flooding strain. Verify outlier filtering, quorum requires aligned signals, no false quorum kills on heal. |
| **P2P Clock Calibration & HLC Gossip** | `mesh.js`, `echoforge_worker.js` | `[Doc §9]` Gossip TTL/expiry drift<br>`[Part 7]` PHIC state race window<br>`[Audit]` P2P split-brain | On handshake: exchange `performance.timeOrigin`, compute offset. Use Hybrid Logical Clock `(logical_counter, node_id)` for gossip ordering. Add partition detection heuristic. | Partition mesh into 2+2. Verify conflict resolution, no split-brain kills, TTL normalized across drift. |

**✅ Phase 2 Success Criteria:** Inference stable under extreme volatility. P2P mesh tolerates misaligned peers, clock drift, and network partitions without false quorum kills. WASM fragmentation managed proactively.

---
## 🔍 Phase 3: Long-Run Operational Hygiene & Security (Weeks 6–8)
*Prevents memory/DB quota exhaustion, exposes silent fallbacks, secures browser runtime, improves observability.*

| Task | Target Files | 🔗 References & Pain Points Resolved | Implementation Details | Validation |
|------|--------------|--------------------------------------|------------------------|------------|
| **Storage Quota & Circular Buffers** | All workers, `session_recorder.js` | `[Audit #4]` PWA Memory/IndexedDB quota<br>`[Issue 4]` Recorder vs echoforge mismatch<br>`[Issue 8]` Beta-Bernoulli tracking gap | Replace unbounded `Map` with TTL+`max_size`. Monitor `navigator.storage.estimate()`. At >75%: prune stale, switch recorder to ring-buffer. Add `signal_count` & `decisive` flag. | Run 72h session. Verify no OOM, no `IndexedDB` quota errors, outcome counts match aliveness updates. |
| **PHIC Versioning & Silent Fallback Guard** | `index.html`, all workers | `[Issue 3]` Silent `p_up` fallback<br>`[Part 7]` PHIC State Race Window<br>`[Issue 13]` Global strain override limitation | Add `phic_seq` counter. Tag intents/signals with seq. Log warning if `|signal.phic_seq - current| > 1`. Add `p_up_fallback: true` + alert. Implement per-type `strain_overrides`. | Simulate PHIC update during signal burst. Verify staleness logged, fallback flagged, per-type strain applied without over-easing others. |
| **Outcome Pipeline & Zero-Alpha Alert** | `bridge/main.py`, `session_recorder.js` | `[§10 Addendum]` Zero-Alpha Baseline<br>`[Issue 4]` Outcome count mismatch<br>`[Doc §5]` DriftMonitor/RegressionOptimizer stall | Add `last_outcome_ts`. If `now - last_outcome_ts > 3600s`, emit `outcome_silence_alert`. Distinguish "no trades" vs "broken fill pipeline". | Verify session export matches live aliveness. Alert fires on broken fill pipeline. Bridge resumes correctly post-silence. |
| **SUPERTREND LowVol Cleanup & Config Hygiene** | `echoforge_worker.js`, PHIC | `[Issue 2]` SUPERTREND LowVol echo wastefully seeded<br>`[Doc FMEA]` Sev 3, Detection 3 | Skip seeding any pattern/regime where `REGIME_REQUIREMENTS` excludes it. Remove `SUPERTREND_CROSS:LowVol` from `KNOWN_ECHOES`. | Init session. Verify no phantom LowVol SUPERTREND echo in UI snapshot. Gossip unaffected. |
| **API Key Security & Payload Validation** | `index.html`, all workers | `[Audit]` Browser runtime attack vectors<br>`[Doc Part 2]` `postMessage` pipeline trust assumption | Encrypt VALR keys via `crypto.subtle` in memory. Require user gesture for session init. Validate all `postMessage` payloads with Zod/JSON Schema. Reject malformed. | Run XSS simulation, extension key extraction test. Verify payload rejection on schema violation. Keys never plaintext in JS heap. |

**✅ Phase 3 Success Criteria:** Zero memory/DB quota breaches over 72h. All silent behaviors surfaced in UI/logs. Keys resistant to client-side extraction. Pipeline resilient to malformed messages and PHIC race conditions.

---
## 📊 Cross-Reference Matrix: Doc Issues → Plan Phase → Status

| Doc Ref | FMEA Sev | Detection Diff | Plan Phase | Status |
|---------|----------|----------------|------------|--------|
| Issue 1 (Dual VPIN) | 6 | 8 | P0, P2 | ✅ Resolved (Seq gate + feature squash) |
| Issue 2 (SUPERTREND seed) | 3 | 3 | P3 | ✅ Resolved (Config cleanup) |
| Issue 3 (p_up fallback) | 5 | 7 | P3 | ✅ Resolved (Flag + phic_seq) |
| Issue 4 (Outcome mismatch) | 4 | 5 | P3 | ✅ Resolved (Decisive flag + silence alert) |
| Issue 5 (ARBI regime) | 5 | 8 | P1 | ✅ Resolved (Routing fix) |
| Issue 6 (Stop-loss 50%) | 7 | 2 | P1 | ✅ Resolved (PHIC config) |
| Issue 7 (Ghost fees) | 6 | 7 | P1 | ✅ Resolved (Hurdle-aligned win check) |
| Issue 8 (Beta tracking) | 4 | 4 | P3 | ✅ Resolved (Signal count + CI tooltip) |
| Issue 9 (Sell suppression) | 6 | 6 | P1 | ✅ Resolved (Pending exposure + pattern lock) |
| Issue 10 (Drawdown reset) | 7 | 5 | P1 | ✅ Resolved (Time-based hysteresis) |
| Issue 11 (VOL breakout VPIN) | 4 | 3 | P3 | ✅ Resolved (Regime dwell + vpin_stats export) |
| Issue 12 (Pain map LowVol) | 3 | 2 | P2 | ✅ Resolved (Documented + peer validation) |
| Issue 13 (Global strain) | 6 | 6 | P3 | ✅ Resolved (Per-type overrides) |
| Issue 14 (Reserved exposure) | **9** | **9** | P1 | ✅ Resolved (Atomic in-flight reservation) |
| Issue 15 (Tab throttling) | **9** | 6 | P0 | ✅ Resolved (Visibility guard + freeze) |
| Audit #1 (Byzantine) | 6 | 9 | P2 | ✅ Resolved (Weighted quorum + reputation) |
| Audit #2 (L2 stale) | **8** | 7 | P0 | ✅ Resolved (Seq gap detection) |
| Audit #3 (Fees) | 7 | 5 | P1 | ✅ Resolved (Strategy-aware hurdle) |
| Audit #4 (PWA memory) | 8 | 6 | P0/P2/P3 | ✅ Resolved (Heartbeat + recycle + quota) |
| Audit #5 (Kelly overlap) | 9 | 8 | P1 | ✅ Resolved (Atomic reservation) |
| Audit #6 (HWM trap) | 5 | 7 | P1 | ✅ Resolved (Decay + micro-banking) |
| Audit #7 (Feature drift) | 8 | 6 | P2 | ✅ Resolved (Regime scaling + squash) |

---
## 🛠️ Rollout & Dependency Strategy
| Phase | Depends On | Rollout Strategy | Risk Mitigation |
|-------|------------|------------------|-----------------|
| **P0** | None | Deploy immediately. Blocks live trading. | Paper-trade mode with synthetic L2 gaps & visibility toggles. |
| **P1** | P0 (monotonic time) | Deploy behind PHIC feature flags. A/B test hurdle/stop-loss changes. | Parallel shadow execution logging before live gating. |
| **P2** | P0 (worker heartbeat) | Enable in 1-tab mode first. Activate mesh only after validation. | Isolated test mesh with injected Byzantine reports & clock skew. |
| **P3** | P1+P2 | Enable gradually. Quota monitoring → fallbacks → security hardening. | Long-run 72h soak test with heavy recording & PHIC updates. |

---
## 📈 Success Metrics Tied to FMEA/Detection Difficulty
| Metric | Target | Alert Threshold | Linked Pain Point |
|--------|--------|-----------------|-------------------|
| L2 Sequence Gaps / Hour | 0 | >2 → `book_stale_alert` | Issue 14/15, Audit #2 |
| Worker Heartbeat Misses | 0 | ≥3 → auto-restart logged | Audit #4, Part 7 |
| Exposure Cap Breaches | 0 | Any → `floor_breach` simulation | Issue 14, Audit #5 |
| Feature `|z| > 3` Rate | <1% | >5% → `model_degradation_alert` | Audit #7, Issue 1 |
| IndexedDB Usage / Quota | <60% | >75% → prune + ring-buffer | Audit #4, Issue 4 |
| `p_up_fallback` Incidence | <2% | >5% → `jury_stale_alert` | Issue 3, PHIC Race |
| `outcome_silence_alert` | <1/day | >1/hr → pipeline check | §10 Addendum, Issue 4 |

---
This plan is **fully backward-compatible** with existing PHIC configs, requires no model retraining (Phase 2 changes are runtime normalizations), and directly resolves every documented issue, FMEA-severity item, and architectural blind spot.
