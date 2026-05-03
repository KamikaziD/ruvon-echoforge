# EchoForge Syndicate — Trading Manual

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Prerequisites & Starting Up](#2-prerequisites--starting-up)
3. [The Browser Interface](#3-the-browser-interface)
4. [Monitor Tab — Node Status Panel](#4-monitor-tab--node-status-panel)
5. [Monitor Tab — Active Echoes Panel](#5-monitor-tab--active-echoes-panel)
6. [Monitor Tab — Execution Log Panel](#6-monitor-tab--execution-log-panel)
7. [Monitor Tab — Sentinel Alerts Panel](#7-monitor-tab--sentinel-alerts-panel)
8. [Monitor Tab — Syndicate Mesh Panel](#8-monitor-tab--syndicate-mesh-panel)
9. [Monitor Tab — Strategy Panel (LLM Planner)](#9-monitor-tab--strategy-panel-llm-planner)
10. [PHIC Governance Panel](#10-phic-governance-panel)
11. [Wallet Stats](#11-wallet-stats)
12. [Market Chart](#12-market-chart)
13. [Chart Tab — Full-Screen View](#13-chart-tab--full-screen-view)
14. [Trading Tab](#14-trading-tab)
15. [Trading Patterns (Strategies)](#15-trading-patterns-strategies)
16. [Regime Detection](#16-regime-detection)
17. [Safety Systems](#17-safety-systems)
18. [Auto-Adapt System](#18-auto-adapt-system)
19. [Daemon Mode](#19-daemon-mode)
20. [Session Management](#20-session-management)
21. [Workflow & Best Practices](#21-workflow--best-practices)
22. [Testing Guide](#22-testing-guide)

---

## 1. System Overview

EchoForge Syndicate is a **browser-native autonomous crypto trading mesh**. It runs entirely inside your web browser using Web Workers — no Python, no external process, no trading software to install. When connected to the EchoForge bridge and mock exchange (or live VALR), it reads order-flow data, generates trade signals, executes orders, and manages portfolio risk — all locally.

### Architecture at a Glance

```text
Browser (index.html)
│
├── orderbook_worker    — VPIN, OFI, spread, market microstructure
├── nociceptor_worker   — Signal generation for each strategy pattern
├── echoforge_worker    — Pattern memory (Bayesian echo lifecycle), intent gating
├── execution_worker    — Order submission, portfolio mirror, stop-loss, profit banking, floor
├── inference_worker    — ONNX AI model (BUY/SELL/HOLD confidence scoring)
├── correlation_worker  — Cross-pair correlation (BTC/ETH/SOL RVR + Pearson)
└── mesh (WebRTC)       — Peer gossip, sovereign election, regime voting
```

Data flows from the exchange → orderbook worker → nociceptor → echoforge → execution. Every worker receives live **PHIC governance updates** from the human operator (you) via sliders and config controls.

### Key Concept: PHIC

**PHIC** (Human-In-Command) is the governance layer. You set strategic boundaries via sliders; the system executes within them. The engine **cannot** exceed your configured position size, drawdown limit, or exposure cap. PHIC controls are live — changes take effect on the next check cycle (within seconds).

---

## 2. Prerequisites & Starting Up

### Services Required

| Service | Default URL | Purpose |
| --- | --- | --- |
| EchoForge Bridge | `http://localhost:8765` | PHIC config sync, telemetry, retrain API |
| Mock VALR Exchange | `http://localhost:8766` | Market data + order execution |
| (Optional) Ollama | `http://host.docker.internal:11434` | LLM Strategy Planner |
| (Optional) Custom Tracker | `ws://localhost:8888` | WebRTC peer signaling |

Start the services with Docker Compose from the `packages/ruvon-echoforge/` directory:

```bash
docker compose up
```

Then open `browser/index.html` in a browser (Chrome or Edge recommended — requires SharedArrayBuffer + WebWorker support).

### First Launch

1. Open `index.html`. The AI inference model begins loading immediately — you will see `⟳ loading model…` in the Strategy panel. This takes 10–50 seconds while WASM compiles.
2. The header shows **VALR SIMULATION** badge (amber) until a live data connection is established.
3. The PHIC panel populates with default values. You can adjust them before starting.

---

## 3. The Browser Interface

The interface has three tabs across the top right of the header:

| Tab | Purpose |
| --- | --- |
| **MONITOR** | Primary operating view — all panels, chart, PHIC controls |
| **TRADING** | Simplified view — node stats on the left, PHIC read-only mirror on the right |
| **CHART** | Full-screen price chart with timeframe selector |

The **MONITOR** tab is the default and is where you will spend most of your time.

The header also shows:

- **Node ID badge** — your browser node's randomly assigned ID (e.g. `EF-A3XZ2`)
- **MESH: N PEERS** badge — number of WebRTC-connected peers in the syndicate
- **🧊 FROZEN** badge — visible only when emergency freeze is active
- **VALR SIMULATION / VALR LIVE** badge — green when connected to real VALR data
- **Latency** — rolling exchange round-trip latency in milliseconds

---

## 4. Monitor Tab — Node Status Panel

This is the left column, occupying the top two-thirds. It contains connection controls, live stats, and operational buttons.

### Connection Fields

| Field | Description |
| --- | --- |
| **Bridge URL** | HTTP URL of the EchoForge bridge (`http://localhost:8765`). Used for PHIC sync, telemetry push, retrain, tune, calibrate, and plan APIs. |
| **Exchange API URL** | HTTP URL of the mock VALR server (`http://localhost:8766`). All order submissions and balance syncs go here. |
| **Syndicate room ID** | WebRTC room name for peer discovery. All nodes in the same room form a mesh. Default: `echoforge-main`. Change to isolate your node from others. |
| **Custom tracker** | Optional WebRTC signaling server. Leave as `ws://localhost:8888` unless you are using a different tracker. |

### Action Buttons

| Button | Action |
| --- | --- |
| **START NODE** | Fetches initial PHIC config from bridge, spawns all Web Workers, connects to exchange WebSocket, begins trading. The session timer starts. |
| **STOP** | Terminates all workers (except the inference worker which persists for reuse), closes connections. The session timer resets. |
| **🧊 FREEZE** | Immediately sets `emergency_freeze: true` across all workers and pushes the freeze to the bridge. No new orders are submitted. Existing positions remain open. |
| **💵 CASH OUT** | Submits a market sell for the entire BTC position, returns to USDT, then triggers an emergency freeze. Use to exit all risk immediately. |
| **⬇ EXPORT SESSION** | Downloads the current session as a JSON file for offline analysis. Filename: `echoforge-session-<id>.json`. |
| **DISCOVER** | Analyses fill history for statistical patterns. Triggers after every 20 fills automatically; this button forces an immediate run. |
| **TUNE** | Grid-searches optimal echo decay parameters from session history. Runs automatically every 15 minutes. Forces a run immediately. Requires at least 5 decisions in the session. |
| **PRETRAIN** | Downloads 3 days of Binance BTCUSDT klines and retrains the ONNX inference model. Run this on first launch if the model fails to load, or after significant market structure changes. |
| **CALIBRATE** | Recalibrates VPIN thresholds from samples collected during this session. Run after at least a few minutes of data collection. Runs automatically every 5 minutes. |

### AUTO-ADAPT Checkbox

When checked (default), the system automatically runs CALIBRATE every 5 minutes, RETRAIN every 10 minutes, and TUNE every 15 minutes. Uncheck to disable automatic adaptation and run everything manually.

### Live Stats Row

| Stat | Description |
| --- | --- |
| **VPIN** | Volume-Synchronized Probability of Informed Trading. Measures order-flow toxicity. 0.0 = clean flow; values above 0.40 indicate elevated informed trading (HighVol regime); above 0.70 indicates crisis. |
| **LATENCY** | Rolling EWMA of exchange round-trip latency in milliseconds. |
| **SAF QUEUE** | Count of orders queued in the Store-and-Forward buffer (IndexedDB). Non-zero means some orders failed to reach the exchange and are waiting for retry. |
| **SESSION** | Elapsed time since START NODE was clicked. Format: `MMm SSs` for under an hour, `Xh MMm` after. Green when running, grey (—) when stopped. |

### Execution Sovereign

Shows which node in the mesh is currently the designated order executor. The sovereign is elected based on lowest latency. When your node is sovereign it shows `SELF (solo)` or your node ID. Non-sovereign nodes route execution intents to the sovereign via mesh.

**S(Ex) SCORE** — The execution quality score for the current sovereign. Higher is better.

### VPIN Toxicity Bar

A horizontal bar gauge beneath the stats. Colour transitions from green (low VPIN) → amber (HighVol) → red (Crisis) as VPIN rises.

---

## 5. Monitor Tab — Active Echoes Panel

Centre column, top row. Shows the live state of all trading pattern "echoes" being tracked.

### What is an Echo?

An echo is the engine's persistent memory of how well a specific trading pattern has been performing in a specific market regime. Every pattern × regime combination has its own echo with an independent **aliveness score** that rises on profitable trades and decays on losses or inactivity.

### Echo Table Columns

| Column | Description |
| --- | --- |
| **PATTERN** | Strategy identifier (e.g. `MOMENTUM_V1`, `REVERSION_A`). See [Section 15](#15-trading-patterns-strategies). |
| **REGIME** | Market regime this echo tracks: `LowVol`, `HighVol`, or `Crisis`. |
| **STATE** | `active` — eligible for execution. `hibernating` — underperforming, runs shadow paper trades to recover. `dead` — terminal, permanently vetoed until manual un-veto. |
| **ALIVENESS** | 0.0–1.0 score. Minimum threshold to generate execution intents is **0.30**. Shown as a bar. Higher = more confident, larger position sizes. |
| **SIGNAL** | Last signal direction: BUY or SELL. |
| **CONF** | AI model confidence for the last signal (`p_up` from ONNX inference). |
| **EXECUTIONS** | Number of times this echo has generated a live trade. |
| **UPDATED** | Time since this echo last received new data. |

### Echo Lifecycle

```text
active ──(losses / aliveness < 0.30)──▶ hibernating ──(quorum strain)──▶ dead
hibernating ──(shadow paper trade aliveness ≥ 0.30 + conditions clear)──▶ active
```

Dead echoes persist for 48 hours before being pruned from memory.

---

## 6. Monitor Tab — Execution Log Panel

Centre column, middle row. Timestamped log of every order event.

### Log Entry Types

| Colour | Type | Meaning |
| --- | --- | --- |
| Green | Order submitted | Fill confirmed. Shows: pattern, side (BUY/SELL), quantity, fill price, PnL for sells. |
| Red | Order failed | Submission rejected. Shows reason (e.g. `pattern cap: 31% ≥ 30%`, `rate limited`, `offline`). |
| Amber | CAP TRIM | Automatic rebalancing sell — position exceeded `max_total_exposure_pct`. Sells down to 70% of the cap. |
| Amber | STOP LOSS | Partial sell (50% of position) triggered by price dropping `stop_loss_pct` below average cost. |
| Green | BANKED T1 | Tier-1 profit banking event. Shows amount locked in and new HWM. |
| Green | BANKED T2 | Tier-2 profit banking event (velocity reversal or dwell fallback). |
| Amber | FLOOR WARN | Portfolio approaching the drawdown floor — intents suspended. |
| Red | FLOOR BREACH | Portfolio hit the floor — emergency freeze + market flatten. |
| Muted | SENTIMENT | Periodic market sentiment score from the bridge (score + momentum). |

---

## 7. Monitor Tab — Sentinel Alerts Panel

Left column, bottom row. Higher-level system events from all workers.

| Alert Type | Meaning |
| --- | --- |
| `REGIME` | Regime changed (committed by mesh quorum). Shows new regime tag. |
| `Nociceptor` / `drawdown_freeze` | Drawdown % exceeded `max_drawdown_pct` for N consecutive samples. Auto-freeze triggered. |
| `Floor` / `FLOOR_WARN` | Portfolio is within 3% above the floor. EchoForge worker has gone passive. |
| `AUTO-ADAPT` | Auto-adapt enabled or disabled. |
| `PHIC` | Governance change applied (hurdle adjustments, regime caps, daemon mode changes). |
| `PLAN` | LLM strategy planner events (requested, applied, target reached, stop loss hit, time expired). |
| `AI RETRAIN` | Model retrain started or completed. |
| `CONTESTED` | A pattern is being contested by peer nodes (local aliveness diverges from peer average). The pattern is blocked from execution until consensus resolves. |

---

## 8. Monitor Tab — Syndicate Mesh Panel

Centre column, bottom row. Shows WebRTC peer connections.

When peers connect, each appears with their node ID, latency, and sovereign status. The mesh uses the **Trystero torrent** strategy (openwebtorrent.com tracker) for peer discovery.

**Sovereign election:** the node with the lowest measured exchange latency becomes the execution sovereign. All other nodes forward their execution intents to the sovereign, which submits the actual orders. This prevents duplicate orders when multiple nodes are running in the same room.

---

## 9. Monitor Tab — Strategy Panel (LLM Planner)

Right column, top section. Allows you to describe a trading objective in plain English and have an LLM generate and enforce a short-term strategy.

### Using the Planner

1. **Type your intent** in the text field, e.g. `Make 5% profit in 20 minutes` or `Protect my position, low risk only`.
2. **Set the Ollama URL** if your local LLM server is at a different address (default: `http://host.docker.internal:11434`).
3. Click **PLAN**. The bridge forwards the request to Ollama (model: `gemma4:e2b`) along with current market context (price, regime, VPIN, portfolio value).
4. The LLM returns a structured plan with: strategy name, target PnL %, stop-loss %, max position %, autonomy level, time horizon, and rationale.
5. The plan is automatically applied to PHIC, overriding your current sliders.

### Active Plan Display

When a plan is running, a stats box appears showing:

- **ACTIVE PLAN** — strategy name from the LLM
- **TIME LEFT** — countdown to plan expiry
- **PnL** — current PnL relative to portfolio value when the plan started
- **Target / Stop / Pos / Auto** — plan parameters
- **Reviews** — how many LLM review cycles have run (max 10)
- **Progress bar** — fills as PnL approaches the target
- **LLM RATIONALE** — the model's explanation of its strategy choice
- **CANCEL** button — ends the plan and leaves PHIC as-is

### Plan Auto-Termination

The plan freezes the engine and terminates if:

- Target PnL is reached
- Stop-loss PnL is hit
- Time horizon expires
- Regime changes (triggers a mid-plan LLM review)

---

## 10. PHIC Governance Panel

Right column, middle section (scrollable). This is the primary control surface. All sliders and inputs take effect immediately and are broadcast to all workers and the bridge simultaneously.

---

### Core Controls

#### AUTONOMY LEVEL (0.0 – 1.0)

Controls how aggressively the engine sizes positions.

- `0.0` — Minimum (effectively pauses trading — orders are submitted but sized near zero)
- `0.5` — Default (balanced)
- `1.0` — Maximum (full position sizes within other caps)

This multiplier is applied to every buy order calculation: `qty = (available_usdt × autonomy × max_position_pct × conviction × kelly) / price`

**Guidance:** Start at 0.3–0.5 while monitoring a new session. Raise to 0.7–0.9 during well-performing, stable periods.

---

#### MAX POSITION % (1% – 100%)

The maximum fraction of available USDT to deploy in a single order.

- Default: 40%
- At 40%, a $10,000 portfolio can deploy up to $4,000 in one buy (before autonomy and conviction scaling)
- Combined with Autonomy Level: actual size ≈ `max_position_pct × autonomy_level × conviction × kelly`

**Guidance:** 20–50% is a reasonable range. Higher values increase potential return and risk per trade.

---

#### MAX DRAWDOWN % (1% – 50%)

Maximum permitted drawdown from the running portfolio peak (high-water mark) before the engine auto-freezes.

- Default: 15%
- Measured against `echoforge_worker`'s internal high-water mark (independent of the profit banking HWM)
- Requires **N consecutive** samples in breach (see Drawdown Hysteresis below) before freeze fires

When the drawdown limit is hit N consecutive times, a `drawdown_freeze` sentinel is emitted, `emergency_freeze` is set to true, and all execution stops.

**Guidance:** 5–15% for conservative operation. The drawdown floor (see [Section 11](#11-wallet-stats)) is a second, independent enforcement layer.

---

#### Drawdown Hysteresis N (1 – 10)

Number of consecutive 30-second checks that must breach `max_drawdown_pct` before auto-freeze fires.

- Default: 3 (i.e., 90 seconds of sustained breach)
- Prevents a single noisy price spike from triggering a freeze
- Set to 1 for immediate response; set higher for noisy markets

---

#### PATTERN CAP % (0% – 100%)

Maximum fraction of total portfolio value that can be exposed in any single trading pattern.

- Default: 30%
- Prevents one strategy from monopolising the position
- Example: at 30% cap on a $10,000 portfolio, `REVERSION_A` can hold at most $3,000 worth of BTC
- Violations are logged as `order_failed: pattern cap` — no order is submitted

**Guidance:** 20–40%. Lower values enforce diversification across patterns.

---

#### TOTAL EXPOSURE % (0% – 100%)

Maximum fraction of total portfolio value held in BTC across all patterns combined.

- Default: 20%
- This is the **aggregate cap** — even if individual patterns are under their cap, combined BTC cannot exceed this
- When exceeded, a **CAP_TRIM** sell fires automatically (within 15 seconds) to bring exposure down to 70% of the cap
- Also used to calculate the **drawdown floor**: `floor = HWM × (1 − total_exposure_pct)`

**Guidance:** 15–30% is conservative. This slider directly sets how much of your portfolio is "at risk" at any moment. Moving it also recalculates the displayed FLOOR value immediately.

---

#### STOP LOSS % (0% – 10%)

Price-based stop-loss for the open BTC position.

- Default: 2.5%
- When the current price drops `stop_loss_pct`% below your average cost basis, a market sell of **50% of the position** fires
- Cooldown: 2 minutes between stop-loss fires (to avoid sell-thrashing on bounces)
- Set to 0 to disable the stop-loss entirely (not recommended)

**Guidance:** 1.5–3.0%. This protects against positions that move strongly against you.

---

### Profit Banking

The profit banking system locks in gains above a running high-water mark so they cannot be re-risked. It operates on a two-tier, velocity-aware mechanism.

**How it works:**

1. The **High-Water Mark (HWM)** tracks the peak portfolio value reached so far
2. When `total_value` rises above HWM by the threshold amount, **Tier 1** fires immediately
3. Tier 1 banks `T1 FRACTION` of the excess, advances the HWM, and records the banked amount as safe reserve
4. **Tier 2** then banks the remaining excess when momentum reverses (velocity EWMA flips negative) or after the fallback dwell time expires

Banked profits are **not subtracted from your portfolio** — they represent a logical safe zone. The HWM advances so the engine treats the banked amount as already captured.

#### THRESHOLD (T1) (0.1% – 5.0%)

How far above the HWM `total_value` must rise before Tier 1 fires.

- Default: 0.2%
- At 0.2% on a $10,000 HWM, Tier 1 fires when portfolio reaches $10,020
- Lower values bank more frequently with smaller increments
- Higher values wait for larger gains before banking

**Guidance:** 0.1–0.5%. In fast markets with short profitable windows, use a lower threshold (0.1–0.2%) to capture gains quickly.

---

#### T1 FRACTION (10% – 100%)

What fraction of the excess above HWM is banked immediately in Tier 1.

- Default: 60%
- At 60%, if the excess is $50, Tier 1 banks $30 and the HWM advances by $30
- The remaining $20 is left for Tier 2 to capture
- Setting to 100% banks everything on Tier 1 (Tier 2 never fires)

**Guidance:** 50–70%. Higher fractions are more conservative; lower fractions leave more for Tier 2's velocity-based capture.

---

#### T2 DWELL (MIN) (1 – 60 minutes)

Fallback time window for Tier 2 banking if no velocity reversal is detected.

- Default: 10 minutes
- After Tier 1 fires and the portfolio stays above the new HWM, Tier 2 waits for either:
  - Portfolio velocity EWMA flips from positive to non-positive (momentum reversal), **or**
  - `T2 DWELL` minutes elapse above HWM
- The EWMA halflife is ~60 seconds (2 checks) so reversals are detected quickly

**Guidance:** 5–15 minutes. In fast, volatile markets use shorter dwell (5 min). In trending, steady markets a longer dwell (15–20 min) gives Tier 2 more time to capture the full run.

---

### Correlation

Controls cross-pair correlation gating. When enabled, trade signals are modulated by whether BTC is moving in sync with ETH/SOL or diverging.

#### ON / OFF Toggle

Enables or disables correlation gating entirely.

#### RVR > (Relative Volatility Ratio threshold, 0.5 – 3.0)

Minimum RVR (ratio of BTC volatility to cross-pair volatility) required for a pattern to get a cross-pair boost. Default: 1.5. Higher values require BTC to be more distinctly volatile.

#### PEARSON < (correlation threshold, 0.10 – 0.90)

Maximum Pearson correlation coefficient between BTC and cross-pair returns permitted before gating a trade. Default: 0.50. When BTC and ETH/SOL are too highly correlated, adding more BTC risk is redundant.

#### BOOST × (0.0 – 0.10)

Fractional aliveness boost applied to echoes when cross-pair correlation conditions are favourable. Default: 0.04 (+4%). Rewards patterns that generate signals when BTC is leading the cross-pair moves.

---

### Vetoed Patterns

A comma-separated list of pattern IDs to permanently block from execution.

- Example: `REVERSION_A,WHALE_WAKE`
- Takes effect immediately; echoes for vetoed patterns still exist but never generate execution intents
- Useful for disabling strategies that consistently underperform in current market conditions
- Clear the field to un-veto all patterns

---

### Regime Caps

Multipliers applied to all position sizes in each market regime. This is a scaler on top of all other sizing constraints.

| Regime | Default | Behaviour |
| --- | --- | --- |
| **LowVol** | 1.0 | Full-size positions allowed |
| **HighVol** | 0.5 | All positions halved |
| **Crisis** | 0.1 | All positions reduced to 10% — effectively near-halted |

Set a regime cap to 0 to fully block trading in that regime. Increase above 1.0 to amplify in low-volatility markets.

---

### Metabolic Insights

The echoforge worker analyses the rolling 24-hour signal outcome log every hour (or every 25 resolved outcomes) and generates hurdle rate suggestions per regime and strategy type.

#### Reading Suggestions

Suggestions appear as rows:

- **RAISE** — this strategy type has been underperforming in this regime; suggest increasing the aliveness strain exponent (making it harder to pass the hurdle)
- **EASE** — this strategy type has been overperforming; suggest easing the hurdle

The panel shows: strategy type, regime, suggested strain value, and the performance metric that triggered the suggestion (mean outcome score and bucket size).

#### AUTO Checkbox

When checked, suggestions are applied automatically as soon as they arrive. The checkbox is next to the METABOLIC INSIGHTS heading.

#### APPLY Button

Manually applies all current suggestions to the `regime_strain_exp` PHIC field. Averages across strategy types if multiple patterns in the same regime have different suggestions.

#### ✕ Button

Dismisses suggestions without applying them.

---

## 11. Wallet Stats

Located at the top of the PHIC panel. Updates after every fill and on every exchange sync.

| Stat | Description |
| --- | --- |
| **USDT** | Available USDT balance (not currently in BTC positions) |
| **BTC HELD** | Current BTC position size in BTC units |
| **NET VALUE** | `usdt + (btc × current_price)` — total portfolio value |
| **REALISED PnL** | Cumulative closed-trade profit/loss since session start |
| **UNREALISED** | Mark-to-market PnL on the current open BTC position |
| **TOTAL PnL** | Realised + unrealised combined |
| **HWM** | High-water mark — the highest `NET VALUE` reached. Drawdown is always measured from this. Advances each time profits are banked. |
| **BANKED** | Cumulative profits locked in as safe reserve. These are profits the engine will not re-risk. |
| **FLOOR** | `HWM × (1 − max_total_exposure_pct)` — the hard minimum portfolio value. If NET VALUE falls to this level, an emergency freeze and market flatten fire automatically. Updates immediately when you move the TOTAL EXPOSURE % slider. |

### Per-Pair Positions

Below the wallet stats, each traded pair shows:

- Trade count and win rate percentage
- Avg cost basis
- Realised PnL for that pair
- Unrealised PnL and current value of the open position

---

## 12. Market Chart

Located in the right column, bottom section of the Monitor tab. Updates every 250ms.

### Indicators

| Series | Colour | Description |
| --- | --- | --- |
| **Price** | White | BTC/USDT mid-price tick |
| **EMA10** | Green | Fast 10-period exponential moving average |
| **EMA20** | Blue | Slow 20-period exponential moving average |
| **VWAP** | Amber (70% opacity) | Volume-weighted average price |
| **BB(20,2)** | Purple (70% opacity) | Bollinger Bands: 20-period SMA ± 2 standard deviations |

### Volume Bars

Small bars at the bottom of the chart. Green = buy volume; red = sell volume for that tick.

### Trade Markers

Filled diamond markers on the price line show where orders were filled. Green = buy fill; red = sell fill.

### Crosshair

Hover the mouse over the chart to see a crosshair with price and time at the cursor position.

### Zoom

- **Mouse wheel** — scroll up to zoom in (fewer data points); scroll down to zoom out
- **− button** — zoom in
- **+ button** — zoom out

The chart buffer holds 3 minutes of data (180 points at 1 point/second).

---

## 13. Chart Tab — Full-Screen View

Click **CHART** in the tab bar for a full-screen version of the market chart.

### Timeframe Selector

| Button | Data Points | Span |
| --- | --- | --- |
| **1m** | 60 | Last 60 seconds |
| **3m** | 180 | Last 3 minutes (default) |
| **5m** | 300 | Last 5 minutes |
| **10m** | 600 | Last 10 minutes |

The crosshair hover and all indicators are identical to the monitor chart.

---

## 14. Trading Tab

Click **TRADING** in the tab bar. This is a simplified two-panel view:

- **Left panel** — Node status summary: VPIN, regime, latency, OFI bias gauge, last 5 fills
- **Right panel** — PHIC read-only mirror showing the current live configuration values

This tab is useful for a clean, distraction-free view of market state and PHIC settings without the full panel grid. PHIC cannot be edited from here — use the Monitor tab's PHIC panel for changes.

---

## 15. Trading Patterns (Strategies)

Seven patterns are tracked simultaneously across all active market regimes.

### Momentum Patterns

| Pattern | Description |
| --- | --- |
| **MOMENTUM_V1** | Detects sustained directional order flow using VPIN + OFI imbalance. Buys when buy flow dominates; sells when sell flow dominates. |
| **DEPTH_GRAB** | Targets large order-book depth imbalances — when a big resting order is about to be swept. |
| **SUPERTREND_CROSS** | Fires on SuperTrend indicator crossovers (10-period, 4× ATR multiplier). 2-minute cooldown between flips to avoid noise. |
| **WHALE_WAKE** | Detects abnormally large individual trades ("whale trades") that signal informed order flow. |

### Mean Reversion Patterns

| Pattern | Description |
| --- | --- |
| **REVERSION_A** | Classic mean reversion — price has extended from VWAP/EMA and is statistically likely to snap back. |
| **SPREAD_FADE** | Exploits temporary bid-ask spread widening; enters a position expecting the spread to compress. |

### Arbitrage Pattern

| Pattern | Description |
| --- | --- |
| **ARBI_CROSS_EXCHANGE** | Cross-exchange price discrepancy. Capped at 0.1 BTC per trade — the timing window is tight. |

### Position Sizing by Pattern

All patterns share the same sizing formula:

```text
qty = (available_usdt × autonomy × max_position_pct × conviction × kelly) / price
```

Where:

- **conviction** = `aliveness ^ 1.5` — higher-aliveness patterns trade proportionally larger
- **kelly** = fractional Kelly criterion from `p_up` (AI model confidence) — capped at 40%

For sells: `qty = available_btc × autonomy × max_position_pct × max(conviction × kelly, floor)`

Strong bearish signals (`net_alpha < -0.005`, `unrealized_pnl < -0.3%`) have a minimum sell fraction to ensure meaningful exits even from near-dead echoes.

---

## 16. Regime Detection

The system classifies market conditions into three regimes using VPIN and exchange latency. Regime changes require **5 consecutive samples** in the new regime and a **60-second cooldown** between transitions. Changes are committed by mesh quorum vote.

| Regime | VPIN Range | Latency | Behaviour |
| --- | --- | --- | --- |
| **LowVol** | Below highvol threshold (default 0.40) | < 100ms | Full position sizes; all patterns eligible |
| **HighVol** | Above 0.40, below crisis threshold (default 0.70) | 100–150ms | Regime cap applied (default 0.5×); momentum patterns preferred |
| **Crisis** | Above 0.70 | > 150ms | Regime cap applied (default 0.1×); near-halted |

**Hysteresis:** transitioning down (e.g. Crisis → HighVol) requires VPIN to fall to 80% of the entry threshold — preventing rapid oscillation at the boundary.

The CALIBRATE function (or auto-calibrate every 5 minutes) updates the `vpin_highvol_threshold` and `vpin_crisis_threshold` values from collected VPIN samples. After calibration, the regime boundaries adapt to the volatility of the current trading session.

The current regime is shown in:

- The **Regime** badge in the Strategy panel (Monitor tab)
- The **td-regime** stat in the Trading tab
- Sentinel Alerts log on every regime transition

---

## 17. Safety Systems

Multiple independent layers protect the portfolio. They operate at different levels of the stack.

### Layer 1 — Pattern Cooldown (execution_worker)

Each pattern has a **30-second minimum cooldown** between trades. Prevents hammering the same signal in fast markets.

### Layer 2 — Pattern Exposure Cap (execution_worker)

`max_pattern_exposure_pct` limits how much BTC any single pattern can hold. Violations are silently rejected.

### Layer 3 — Total Exposure Cap + CAP TRIM (execution_worker)

`max_total_exposure_pct` limits aggregate BTC. When exceeded by >0.2%, a `CAP_TRIM` market sell fires within 15 seconds (15-second cooldown), reducing the position to 70% of the cap.

### Layer 4 — Stop Loss (execution_worker)

`stop_loss_pct`: when price drops this % below your average cost, 50% of the position is sold. 2-minute cooldown. Repeats after cooldown if still underwater.

### Layer 5 — Profit Banking Floor (execution_worker)

`FLOOR = HWM × (1 − max_total_exposure_pct)`. Two-level response:

1. **Warning zone** (within 3% above floor): `floor_warning` sent to echoforge_worker → echoforge goes passive immediately, no new execution intents
2. **Hard breach** (tv ≤ floor): `floor_breach` sent → main thread calls `emergency_freeze` → all workers frozen → any open BTC position is market-sold

### Layer 6 — Drawdown Freeze (echoforge_worker)

Independent of the floor, the echoforge worker tracks its own drawdown from a separate HWM. If drawdown exceeds `max_drawdown_pct` for `drawdown_hysteresis_n` consecutive checks, a `drawdown_freeze` sentinel fires → emergency freeze.

### Layer 7 — Emergency Freeze (global)

`emergency_freeze: true` stops all order submission across all workers instantly. The **🧊 FROZEN** badge appears in the header and on the PHIC panel. To resume trading:

1. Investigate the cause in the Sentinel Alerts feed
2. Adjust PHIC if needed
3. Slide Autonomy Level to reset, or push a new PHIC config from the bridge
4. Re-click START NODE (stop and restart clears the freeze)

### Layer 8 — Mesh Quorum Veto (echoforge_worker)

If 3 or more peers simultaneously report **metabolic strain** (loss outcome_score < −0.30) for the same pattern, the pattern is globally vetoed (`dead` state) across the mesh. Any open position from that pattern is market-sold. The pattern remains dead until you manually remove it from the vetoed list.

### Store-and-Forward (SAF)

Orders that fail due to network errors or rate limits are queued in IndexedDB (not lost). They are retried every 30 seconds. Each entry has a 5-minute TTL and 5 maximum retries. The **SAF QUEUE** stat shows how many are pending. This ensures no trades are permanently dropped during short connectivity interruptions.

---

## 18. Auto-Adapt System

When **AUTO-ADAPT** is checked, three background processes run automatically after START NODE:

| Process | Interval | Condition |
| --- | --- | --- |
| **CALIBRATE** | Every 5 min | Requires ≥100 VPIN samples; skipped if VPIN is in or near crisis |
| **RETRAIN** | Every 10 min | Requires at least one fill in the outcome log |
| **TUNE** | Every 15 min | Requires ≥5 decisions in session recorder |

**CALIBRATE** recalculates VPIN threshold percentiles from collected samples, adapting regime boundaries to the current market volatility level.

**RETRAIN** sends all fills with their feature vectors (VPIN, spread, OFI, EMA gradient, etc.) to the bridge's `/api/v1/adapt/retrain` endpoint. The bridge trains a new ONNX model and returns it. The inference worker hot-swaps the model without restarting.

**TUNE** exports the current session from the recorder and POSTs it to `/api/v1/adapt/tune-banking`. The bridge grid-searches optimal decay rate and loss multiplier combinations and returns the best parameters. These are applied to PHIC as `decay_rate` and `loss_multiplier`.

**DISCOVER** (automatic every 20 fills, or manual) POSTs fill history to `/api/v1/adapt/discover`. The bridge analyses for pattern-level statistical relationships and returns findings to the Sentinel Alerts feed.

The **auto-adapt-status** indicator next to the checkbox shows the current phase (`calibrating…`, `retraining…`, `tuning…`) so you always know what is running.

---

## 19. Daemon Mode

The bridge can run a Python-side EchoForge daemon (server process) that mirrors the browser's trading logic. This enables:

- Trading to continue when the browser tab is closed
- Higher-precision VPIN from a larger data window
- Dual-mode operation (browser for UI, daemon for execution)

### DAEMON MODE Toggle (PHIC Panel)

| Mode | Behaviour |
| --- | --- |
| **OBSERVE ONLY** (default) | Daemon connects and shows telemetry but submits no orders. Bridge receives PHIC updates. |
| **ASSIST TRADING** | Daemon can submit orders. Browser execution continues in parallel unless WALLET SOURCE is set to DAEMON. |

### WALLET SOURCE Toggle (visible in ASSIST TRADING mode)

| Source | Behaviour |
| --- | --- |
| **BROWSER** | Browser execution_worker is the portfolio authority. Daemon observes but doesn't execute. |
| **DAEMON (LIVE)** | Daemon holds the real VALR balance and executes orders. Browser execution is paused (`execution_disabled`) to prevent double-ordering. |

---

## 20. Session Management

### Session Recorder

All significant events are recorded to IndexedDB by the `session_recorder.js` module. The recorder captures:

- Trade decisions and fill outcomes
- Regime changes
- Portfolio snapshots (every portfolio_update: total_value, HWM, banked profit, PnL)
- Sentinel alerts

Sessions older than 8 days are pruned automatically on START NODE.

### Exporting a Session

Click **⬇ EXPORT SESSION** (or call `exportSession()` from the DevTools console). Downloads a JSON file: `echoforge-session-<8-char-id>.json`.

The session JSON contains decisions, events, fills, and metadata for post-session analysis or to submit to the bridge's tune/adapt endpoints.

### Console Utilities

| Command | Description |
| --- | --- |
| `sessionStats()` | Print session statistics to the console |
| `exportSession()` | Download the current session JSON |

---

## 21. Workflow & Best Practices

### Recommended Startup Sequence

1. Start Docker services: `docker compose up`
2. Open `index.html` — wait for AI model to finish loading (`inference_ready` appears)
3. If the model fails to load (stuck on `⟳ loading model…` after 50 seconds), click **PRETRAIN** and wait for it to complete (2–5 minutes)
4. Review PHIC defaults (Autonomy Level 0.5, Max Position 40%, Max Drawdown 15% are reasonable starting points)
5. Click **START NODE**
6. Watch the Execution Log for the first fills and confirm the SAF Queue stays at 0
7. Let at least 100 VPIN samples accumulate (about 2–3 minutes), then click **CALIBRATE** once manually before AUTO-ADAPT takes over

### Conservative Configuration (New Session)

```text
Autonomy Level:     0.30
Max Position %:     20%
Max Drawdown %:     10%
Hysteresis N:       3
Pattern Cap %:      20%
Total Exposure %:   15%
Stop Loss %:        2.0%
Banking Threshold:  0.2%
T1 Fraction:        60%
T2 Dwell:           10 min
Regime Caps:        LowVol=1.0, HighVol=0.3, Crisis=0.05
```

### Aggressive Configuration (High-Confidence Session)

```text
Autonomy Level:     0.80
Max Position %:     50%
Max Drawdown %:     20%
Hysteresis N:       2
Pattern Cap %:      35%
Total Exposure %:   25%
Stop Loss %:        3.0%
Banking Threshold:  0.1%
T1 Fraction:        70%
T2 Dwell:           5 min
```

### Responding to a Freeze

1. Check **Sentinel Alerts** for the freeze cause
2. If `drawdown_freeze`: review the current regime and whether `max_drawdown_pct` is too tight for current volatility. Recalibrate VPIN thresholds
3. If `floor_breach`: the portfolio has reached the HWM-based floor. Banking was not fast enough. Consider lowering the banking threshold and T2 dwell for the next session
4. If `FLOOR_WARN` preceded the breach: the warning fired but the floor was still breached (market moved faster than the 30-second check interval). This is a fast-market condition — consider raising `Total Exposure %` slightly to give more floor clearance
5. To resume: click **STOP**, then **START NODE**. This clears the freeze and resets all workers

### Reading the Floor

The FLOOR stat box is the most important safety number to watch. It tells you: **if NET VALUE reaches this number, trading stops**.

Example:

- HWM = $10,500, Total Exposure = 20%
- Floor = $10,500 × 0.80 = $8,400
- If the portfolio draws down to $8,400, an emergency freeze fires

Move the **TOTAL EXPOSURE %** slider to change the floor distance:

- Lower exposure % → floor is higher → less drawdown permitted
- Higher exposure % → floor is lower → more drawdown permitted

The floor updates immediately on slider change — you can see the FLOOR stat box change in real time.

### Interpreting Metabolic Insights

Metabolic Insights appear after 25+ resolved outcomes (1 outcome = 1 completed round-trip: a BUY fill followed by a SELL or time-expiry). The suggestions are based on real fill performance grouped by regime and strategy type.

- **"RAISE strain for MOMENTUM in HighVol"** means: momentum strategies have been losing money in HighVol recently — increase the strain exponent so they face a tougher aliveness hurdle
- **"EASE strain for REVERSION in LowVol"** means: mean reversion has been profitable in LowVol — reduce the hurdle to encourage more signals

Click **AUTO** to apply these as they arrive. Review suggestions manually during the first few sessions to build intuition before enabling auto-apply.

### When to Use the LLM Planner

Use the Strategy planner when you have a specific, time-boxed objective. The planner overrides your current PHIC autonomy and position settings for the duration of the plan, then freezes when the target, stop, or time limit is reached.

It works best when:

- Market regime is LowVol or HighVol (not Crisis)
- The AI model is loaded and inference-ready
- Your portfolio has a clear entry point (just started a session, or just cleared from a previous plan)

Avoid using it if you are already near the floor — the plan's stop-loss might conflict with the floor enforcement.

---

## 22. Testing Guide

Each test below describes the **setup**, the **action to take**, and the **expected outcome** you should see. All tests assume the Docker stack is running and you are on the Monitor tab.

---

### Test 1 — Session Timer

**What it tests:** Timer starts on START NODE, resets on STOP.

**Steps:**

1. Note the SESSION stat box — it shows `—`.
2. Click **START NODE**.
3. Observe the SESSION stat box. Within 1 second it should turn green and begin counting (`00m 01s`, `00m 02s`, …).
4. Click **STOP**.

**Expected:** SESSION returns to `—` and turns grey immediately.

---

### Test 2 — Emergency Freeze Button

**What it tests:** Manual freeze halts all execution instantly.

**Steps:**

1. Click **START NODE** and wait for fills to appear in the Execution Log.
2. Click **🧊 FREEZE**.

**Expected:**

- The **🧊 FROZEN** badge appears in the header (red).
- A second **FROZEN** badge appears at the top of the PHIC panel.
- No new order entries appear in the Execution Log.
- Sentinel Alerts shows a `PHIC` entry: `emergency_freeze → true`.

**To recover:** Click **STOP**, then **START NODE**.

---

### Test 3 — Cash Out

**What it tests:** CASH OUT flattens the position and then freezes.

**Setup:** Start node and wait until BTC HELD > 0 in the wallet stats.

**Steps:**

1. Note the BTC HELD and NET VALUE values.
2. Click **💵 CASH OUT**.

**Expected:**

- Execution Log shows a `CASHOUT` sell order submitted for the full BTC quantity.
- BTC HELD drops to 0; USDT increases by the sell proceeds.
- The **🧊 FROZEN** badge appears — engine is frozen after cashout.
- Sentinel Alerts shows the cashout completion event.

---

### Test 4 — FLOOR Display Updates on Slider Change

**What it tests:** Moving TOTAL EXPOSURE % recalculates FLOOR immediately.

**Steps:**

1. Note the current HWM and FLOOR values in the wallet stats.
2. Move the **TOTAL EXPOSURE %** slider from 20% to 10%.

**Expected:** The FLOOR stat box updates immediately (within the same render frame). New floor = HWM × 0.90. No need to wait for the next portfolio_update.

**Then:**

1. Move the slider back to 20%.

**Expected:** FLOOR returns to HWM × 0.80.

---

### Test 5 — Pattern Cap Enforcement

**What it tests:** Orders rejected when a single pattern exceeds `max_pattern_exposure_pct`.

**Setup:** Set **PATTERN CAP %** to a very low value — slide it to 5%.

**Steps:**

1. Click **START NODE** and let trading run for 2–3 minutes.
2. Watch the Execution Log.

**Expected:** After the first fill for any pattern, subsequent buy intents from the same pattern will appear as red `order_failed: pattern cap: X% ≥ 5%` entries. Sells are not blocked (cap only gates buys).

**Reset:** Restore PATTERN CAP % to 30%.

---

### Test 6 — Total Exposure Cap + CAP TRIM

**What it tests:** Aggregate BTC cap triggers an automatic trim sell.

**Setup:** Set **TOTAL EXPOSURE %** to 5% (very tight cap).

**Steps:**

1. Click **START NODE**.
2. Wait for any buy fills to accumulate.

**Expected:**

- Once aggregate BTC value exceeds 5% of NET VALUE, a `CAP_TRIM` sell appears in the Execution Log (amber).
- The sell reduces BTC to approximately 70% of the 5% cap (≈ 3.5% of portfolio).
- The trim fires again within 15 seconds if exposure creeps back over the cap.

**Reset:** Restore TOTAL EXPOSURE % to 20%.

---

### Test 7 — Stop Loss Trigger

**What it tests:** Price-based stop fires when position is underwater.

**Setup:** Set **STOP LOSS %** to 0.1% (fires almost immediately on any downward move).

**Steps:**

1. Click **START NODE** and wait for a BUY fill (BTC HELD > 0).
2. Note the **avg_cost** in the per-pair position table.
3. If using the mock exchange (synthetic prices), the price will oscillate — a 0.1% drop from avg_cost fires the stop.

**Expected:**

- Execution Log shows a `STOP_LOSS` sell order for 50% of the held BTC.
- UNREALISED PnL decreases (the losing half of the position is closed).
- If price stays below avg_cost for another 2 minutes, a second STOP_LOSS sell fires for 50% of the remaining position.

**Reset:** Restore STOP LOSS % to 2.5%.

---

### Test 8 — Profit Banking (Tier 1)

**What it tests:** Tier 1 banking fires when portfolio exceeds HWM by threshold.

**Setup:**

- Set **THRESHOLD (T1)** to 0.1% (fires at a very small gain above HWM).
- Set **T1 FRACTION** to 100% (banks everything immediately for clarity).

**Steps:**

1. Click **START NODE** and wait for the portfolio NET VALUE to rise above HWM (visible when NET VALUE > HWM in wallet stats).

**Expected within the next 30-second check:**

- Execution Log shows `BANKED T1 +$X [threshold_crossed]`.
- The **BANKED** stat box updates with the banked amount.
- The **HWM** stat box advances to the new peak.

**Reset:** Restore THRESHOLD to 0.2% and T1 FRACTION to 60%.

---

### Test 9 — Floor Warning (Proactive Layer)

**What it tests:** Floor warning fires before the hard breach and suspends new intents.

**Setup:**

- Set **TOTAL EXPOSURE %** to 20% (floor = HWM × 0.80).
- Artificially tighten the floor by setting MAX DRAWDOWN to 1% and Hysteresis N to 1 so the engine is sensitive.

**Steps:**

1. Click **START NODE**.
2. Let portfolio draw down slightly — in the mock exchange, price oscillations will cause small losses.
3. Watch for the floor warning zone (NET VALUE within 3% of FLOOR).

**Expected when NET VALUE reaches FLOOR × 1.03:**

- Sentinel Alerts shows `Floor / FLOOR_WARN: Approaching floor $X — intents suspended`.
- Execution Log stops showing new buy orders (echoforge_worker has gone passive).
- The 🧊 FROZEN badge does **not** appear yet — only the warning fires at this stage.

**Expected if NET VALUE reaches FLOOR:**

- Execution Log shows `FLOOR_BREACH`.
- The 🧊 FROZEN badge appears.
- A `FLOOR_BREACH` market sell fires for any open BTC.

---

### Test 10 — Drawdown Freeze (echoforge_worker Layer)

**What it tests:** Sustained drawdown beyond `max_drawdown_pct` triggers auto-freeze.

**Setup:** Set **MAX DRAWDOWN %** to 1% and **Hysteresis N** to 1.

**Steps:**

1. Click **START NODE** and let trading run with any open position.
2. A 1% drawdown from the echoforge internal HWM will trigger a freeze after 1 check (~30 seconds).

**Expected:**

- Sentinel Alerts shows `Nociceptor / drawdown_freeze: Drawdown X% ≥ limit 1% for 1 samples — auto-freeze`.
- The 🧊 FROZEN badge appears.

**Reset:** Restore MAX DRAWDOWN % to 15%, Hysteresis N to 3.

---

### Test 11 — Vetoed Patterns

**What it tests:** Vetoing a pattern blocks all execution intents from it.

**Steps:**

1. Click **START NODE** and observe which patterns appear in the Active Echoes table.
2. In the VETOED PATTERNS field, type `MOMENTUM_V1` and press Enter or Tab.
3. Watch the Execution Log for the next 2–3 minutes.

**Expected:** No new buy or sell orders from `MOMENTUM_V1` appear. Other patterns continue trading normally. The echo for `MOMENTUM_V1` remains visible in the table but generates no executions.

**Reset:**

1. Clear the vetoed patterns field and press Enter to un-veto.

**Expected:** `MOMENTUM_V1` resumes generating intents on the next signal.

---

### Test 12 — Regime Cap

**What it tests:** Regime caps reduce position size in specific regimes.

**Steps:**

1. Set the **HighVol** regime cap to `0` (zero).
2. Click **START NODE**.
3. Wait for or trigger a HighVol regime (VPIN > 0.40).

**Expected:** While in HighVol regime, all buy orders are rejected silently (size would be 0). The Execution Log shows no fills during HighVol periods.

**Reset:**

1. Restore the HighVol cap to `0.5`.

---

### Test 13 — Metabolic Insights AUTO Apply

**What it tests:** AUTO checkbox applies suggestions immediately as they arrive.

**Steps:**

1. Check the **AUTO** checkbox in the Metabolic Insights section.
2. Click **START NODE** and let trading run until at least 25 fills accumulate.

**Expected:** When the echoforge worker emits a `hurdle_suggestion` (every 25 resolved outcomes or hourly), the Sentinel Alerts panel shows a `PHIC` entry: `Applied hurdle adjustments: LowVol=X.XX | HighVol=Y.YY`. No manual APPLY click is needed.

With AUTO unchecked: the APPLY and ✕ buttons appear and the suggestion waits for manual action.

---

### Test 14 — SAF Queue (Offline Resilience)

**What it tests:** Orders queue in IndexedDB when the exchange is unreachable and replay on reconnect.

**Steps:**

1. Click **START NODE**.
2. Stop the mock exchange container: `docker stop echoforge-mock-valr`.
3. Watch the SAF QUEUE stat box.

**Expected:**

- Failed orders appear as red `order_failed` entries in the Execution Log with the network error reason.
- The SAF QUEUE counter increments.
- Sentinel Alerts shows nothing — SAF is silent until replay.

**Then:**

1. Restart the mock exchange: `docker start echoforge-mock-valr`.

**Expected:**

- Within 30 seconds, queued orders are replayed.
- Execution Log shows successful fills for the replayed orders (or `EXPIRED` if the 5-minute TTL passed).
- SAF QUEUE drops back to 0.

---

### Test 15 — Auto-Adapt Cycle

**What it tests:** CALIBRATE, RETRAIN, and TUNE fire on schedule.

**Steps:**

1. Check that **AUTO-ADAPT** is checked.
2. Click **START NODE**.
3. Watch the `auto-adapt-status` indicator next to the AUTO-ADAPT checkbox.

**Expected timeline:**

- After ~2–3 minutes (≥100 VPIN samples): `calibrating…` appears briefly, then clears.
- After ~10 minutes (first fills present): `retraining…` appears. Sentinel Alerts shows `AI RETRAIN` start and completion entries.
- After ~15 minutes (≥5 session decisions): `tuning…` appears briefly.

Each cycle completes in a few seconds and the status clears automatically.

---

### Test 16 — LLM Strategy Plan (requires Ollama running)

**What it tests:** End-to-end plan request, application, and auto-termination.

**Steps:**

1. Click **START NODE** and confirm the AI model is loaded (`inference_ready` in Sentinel Alerts).
2. Type `Make 2% profit in 5 minutes` in the plan intent field.
3. Click **PLAN**.

**Expected:**

- Sentinel Alerts shows `PLAN: Requesting strategy…` then `PLAN: "<strategy name>" — target=2% stop=X%…`.
- PHIC sliders update to the plan's values.
- The ACTIVE PLAN stats box appears with countdown timer, PnL tracker, and rationale.
- Plan terminates (with FREEZE) when target is reached, stop is hit, or 5 minutes expire.

---

### Test 17 — Export Session

**What it tests:** Session recorder captures events and export works.

**Steps:**

1. Run a session for at least 5 minutes with AUTO-ADAPT enabled.
2. Click **⬇ EXPORT SESSION**.

**Expected:**

- Browser downloads `echoforge-session-XXXXXXXX.json`.
- Open the file — it contains `decisions`, `events` (including portfolio snapshots and regime changes), and session metadata.
- The `decisions` array grows with each fill; `events` array contains `portfolio` snapshot entries with `hwm`, `banked_profit`, and `total_value`.
