/**
 * runner.js — EchoForge daemon subprocess entry point
 *
 * Spawns all 6 EchoForge workers as Node.js worker_threads, wires their
 * inter-worker message routing (mirroring index.html), connects the VALR WS
 * adapter, and opens a local WebSocket on :8767 for IPC with the Python host.
 *
 * Managed by ruvon-edge's EchoForgeExtension — never run standalone in prod.
 *
 * Environment:
 *   ECHOFORGE_EXCHANGE_URL  e.g. "http://localhost:8766" (mock) or "https://api.valr.com"
 *   ECHOFORGE_IPC_PORT      IPC WebSocket port (default 8767)
 *   ECHOFORGE_DB_PATH       SQLite path for IDB shim (default "echoforge-edge.db")
 *
 * Startup sequence:
 *   1. SAB/Atomics guard (fail fast if environment is misconfigured)
 *   2. Create SharedArrayBuffer ring buffer
 *   3. Inject IndexedDB shim into globalThis
 *   4. Spawn 6 workers via worker_threads
 *   5. Wire inter-worker messages
 *   6. Connect VALR WS adapter
 *   7. Open IPC WebSocket on :ECHOFORGE_IPC_PORT
 *   8. Start heartbeat loop (→ Python every 30s)
 */

"use strict";

import { Worker }     from "worker_threads";
import { WebSocketServer, WebSocket as WS } from "ws";
import http           from "http";
import fs             from "fs";
import path           from "path";
import { fileURLToPath } from "url";

import { indexedDBShim, setIPCSend }  from "./shims/indexed-db.js";
import { VALRWebSocketAdapter }       from "./adapters/valr-ws.js";
import { BinanceWebSocketAdapter }    from "./adapters/binance-ws.js";
import { Database as BunDB }          from "bun:sqlite";

// NATS JetStream — optional; daemon works without it if NATS is down
let _natsConn = null;
let _natsJs   = null;

async function _natsConnect() {
  const natsUrl = process.env.ECHOFORGE_NATS_URL || "nats://localhost:4222";
  try {
    const { connect, StringCodec } = await import("nats");
    globalThis._natsStringCodec = StringCodec();
    _natsConn = await connect({ servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 });
    _natsJs   = _natsConn.jetstream();
    console.info("[nats] Connected to %s", natsUrl);

    // Subscribe to remote PHIC config pushes (from dashboard or admin tooling)
    const sub = _natsConn.subscribe("echoforge.phic.config");
    (async () => {
      for await (const m of sub) {
        try {
          const config = JSON.parse(globalThis._natsStringCodec.decode(m.data));
          _phic = { ..._phic, ...config };
          for (const w of Object.values(_workers)) w.postMessage({ type: "phic_update", config });
          _ipcSend({ type: "phic_update", config: _phic });
          _broadcastPhic({ type: "phic_update", config: _phic });
        } catch (_) {}
      }
    })().catch(() => {});
  } catch (err) {
    console.warn("[nats] Unavailable (%s) — continuing without JetStream", err.message);
  }
}

function _natsPublish(subject, payload) {
  if (!_natsConn || _natsConn.isClosed()) return;
  try {
    const encoded = globalThis._natsStringCodec?.encode(JSON.stringify(payload));
    if (encoded) _natsJs?.publish(subject, encoded).catch(() => {});
  } catch (_) {}
}

// ── 1. SAB / Atomics guard ─────────────────────────────────────────────────
if (typeof SharedArrayBuffer === "undefined" || typeof Atomics === "undefined") {
  console.error(
    "[runner] SharedArrayBuffer or Atomics not available.\n" +
    "         Run Bun >= 1.0 or Node.js >= 18 with --experimental-wasm-threads."
  );
  process.exit(1);
}

// ── Resolve onnxruntime-node absolute path so browser/ort.js can find it ──
// ort.js lives in browser/ and resolves imports from there — daemon/node_modules
// is outside that tree. We set ECHOFORGE_ORT_PATH to the resolved file:// URL
// so ort.js's dynamic import() hits the correct package regardless of cwd.
try {
  process.env.ECHOFORGE_ORT_PATH = import.meta.resolve("onnxruntime-node");
} catch (_e) {
  console.warn("[runner] onnxruntime-node not found — inference worker will be unavailable");
}

// ── Config ─────────────────────────────────────────────────────────────────
const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR   = path.resolve(__dirname, "../../browser");  // path to JS worker files
const EXCHANGE_URL  = process.env.ECHOFORGE_EXCHANGE_URL || "http://localhost:8766";
const WS_URL        = EXCHANGE_URL.replace(/^http/, "ws") + "/v1/ws";
const IPC_PORT      = parseInt(process.env.ECHOFORGE_IPC_PORT  || "8767", 10);
const BRIDGE_PORT   = parseInt(process.env.ECHOFORGE_BRIDGE_PORT || "8765", 10);
const HEARTBEAT_MS  = 30_000;

// ── 2. SharedArrayBuffer ring buffer (1 MB — same as browser createRingBuffer) ─
const RING_BUFFER_SIZE = 1 * 1024 * 1024;
const sab = new SharedArrayBuffer(RING_BUFFER_SIZE);

// ── 3. Inject IndexedDB shim ───────────────────────────────────────────────
// execution_worker.js uses globalThis.indexedDB — inject before workers load.
globalThis.indexedDB = indexedDBShim;

// ── Session corpus (SQLite) ────────────────────────────────────────────────
// Aggregates tick/decision/outcome records from all browser tabs across sessions.
// Feeds corpus-aware retrain — richer training signal than single-tab request body.
// Uses a separate file from ECHOFORGE_DB_PATH (the SAF/IDB shim file) to avoid
// concurrent Bun SQLite handles to the same file across the main thread + worker threads.
const DB_PATH       = process.env.ECHOFORGE_DB_PATH || "echoforge-edge.db";
const CORPUS_DB_PATH = process.env.ECHOFORGE_CORPUS_DB_PATH || "echoforge-corpus.db";
const _corpusDb  = new BunDB(CORPUS_DB_PATH);
_corpusDb.run(`
  CREATE TABLE IF NOT EXISTS echoforge_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    tab_id     TEXT    NOT NULL,
    ts         INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    payload    TEXT    NOT NULL
  )
`);
_corpusDb.run(`CREATE INDEX IF NOT EXISTS idx_sessions_type_ts ON echoforge_sessions (type, ts)`);

const _corpusInsert = _corpusDb.prepare(
  "INSERT INTO echoforge_sessions (session_id, tab_id, ts, type, payload) VALUES (?, ?, ?, ?, ?)"
);
const _corpusInsertMany = _corpusDb.transaction((rows) => {
  for (const r of rows) _corpusInsert.run(r.session_id, r.tab_id, r.ts, r.type, r.payload);
});

// ── IPC state ──────────────────────────────────────────────────────────────
let _ipcSocket = null;  // current Python host WS connection (only one at a time)
let _phic      = { execution_disabled: true };  // daemon starts in observe mode; browser enables via /api/v1/phic/config
let _regime    = "LowVol";

// Inference cache — stores p_up per pattern so execution_intent can be Kelly-scaled
const _inferenceCache = new Map();  // "pattern_id:regime_tag" → { p_up }

// Portfolio state — forwarded to echoforge_worker as position_update on every fill
let _portfolio  = { btc: 0, avg_cost: 0, unrealized_pnl: 0, total_value: 10000 };
let _lastPrice  = 0;   // updated from orderbook ticks — passed as market_price so execution_worker never trades blind

// ── Fee defaults (match browser defaults; fetched at startup if exchange is live) ──
let _makerFee = 0.0005;
let _takerFee = 0.001;

// ── Market state from last BTC orderbook tick — used for trend filtering ──
// Updated on every tick so inference_result handler can apply EMA-based trend guard.
const _lastMarket = { ema_fast: 0, ema_slow: 0, momentum: 0 };

// ── Last known exchange latency (ms) — updated from nociceptor latency_report ──
let _exchangeLatencyMs = 10;

// ── SuperTrend state — for SUPERTREND_CROSS signal emission ───────────────
const ST_PERIOD           = 10;
const ST_MULT             = 4.0;   // wider bands reduce whipsawing on 100ms orderbook ticks
const ST_ALPHA            = 2 / (ST_PERIOD + 1);
const ST_FLIP_COOLDOWN_MS = 120_000;  // 2 min minimum between consecutive flip signals
let _stATR                = 0;
let _stDir                = 0;  // 0=uninitialised, 1=bullish, -1=bearish
let _stLine               = 0;
let _stPrevPrice          = 0;
let _stLastFlipAt         = 0;

// ── Whale Wake throttle (log + emit at most once every 10s) ──────────────
let _lastWhaleEmitAt = 0;

function _ipcSend(msg) {
  if (_ipcSocket && _ipcSocket.readyState === WS.OPEN) {
    try { _ipcSocket.send(JSON.stringify(msg)); } catch (_) {}
  }
}

// Wire IDB shim write-through to IPC send
setIPCSend(_ipcSend);

// ── Browser-facing API server (:BRIDGE_PORT) ───────────────────────────────
// Drop-in replacement for the old Python bridge — same HTTP + WS endpoints so
// browser/index.html and the Next.js dashboard need no URL changes.
//
//   GET  /api/v1/phic/config   → current _phic JSON
//   POST /api/v1/phic/config   → merge config, push to workers + IPC
//   POST /api/v1/phic/freeze   → emergency_freeze to all workers
//   WS   /api/v1/phic/ws      → pushed phic_update / receives phic_update
//   WS   /api/v1/metrics      → pushed metrics_snapshot from browser
//   WS   /api/v1/tick         → pushed echo_snapshot / vpin_update / sentinel_alert

const _bsPhic   = new Set();  // PHIC config subscribers (/api/v1/phic/ws)
const _bsStream = new Set();  // unified stream — /api/v1/metrics (dashboard) + /api/v1/tick (browser)
                               // Both paths join the same set; all events broadcast to all subscribers.

function _broadcastPhic(msg) {
  const str = JSON.stringify(msg);
  for (const ws of _bsPhic) {
    try { if (ws.readyState === WS.OPEN) ws.send(str); } catch (_) {}
  }
}

function _broadcastStream(msg) {
  const str = JSON.stringify(msg);
  for (const ws of _bsStream) {
    try { if (ws.readyState === WS.OPEN) ws.send(str); } catch (_) {}
  }
}


const _wssPhic    = new WebSocketServer({ noServer: true });
const _wssMetrics = new WebSocketServer({ noServer: true });
const _wssTick    = new WebSocketServer({ noServer: true });

_wssPhic.on("connection", (ws) => {
  _bsPhic.add(ws);
  ws.send(JSON.stringify({ type: "phic_config", config: _phic }));
  ws.on("close", () => _bsPhic.delete(ws));
  ws.on("error", () => ws.close());
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "phic_update" && msg.config) {
        _phic = { ..._phic, ...msg.config };
        for (const w of Object.values(_workers)) w.postMessage({ type: "phic_update", config: _phic });
        _ipcSend({ type: "phic_update", config: _phic });
        _broadcastPhic({ type: "phic_update", config: _phic });
      }
    } catch (_) {}
  });
});

// Dashboard subscribes on /api/v1/metrics — joins the unified stream.
_wssMetrics.on("connection", (ws) => {
  _bsStream.add(ws);
  // Seed the equity curve immediately so dashboard doesn't wait for the next trade
  ws.send(JSON.stringify({ type: "portfolio_update", ..._portfolio, timestamp: Date.now() }));
  ws.on("close", () => _bsStream.delete(ws));
  ws.on("error", () => ws.close());
  // Dashboard can send control messages (e.g. freeze) — relay to Python IPC.
  ws.on("message", (raw) => {
    try { _ipcSend(JSON.parse(raw.toString())); } catch (_) {}
  });
});

// Periodic portfolio broadcast so equity curve accumulates even between trades
setInterval(() => _broadcastStream({ type: "portfolio_update", ..._portfolio, timestamp: Date.now() }), 30_000);

// Browser tab subscribes on /api/v1/tick — also joins the unified stream.
// Messages the browser sends here (metrics_snapshot, order_submitted, echo_snapshot, etc.)
// are relayed to ALL stream subscribers so the dashboard sees live browser events.
_wssTick.on("connection", (ws) => {
  _bsStream.add(ws);
  ws.on("close", () => _bsStream.delete(ws));
  ws.on("error", () => ws.close());
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      _ipcSend(msg);           // Python IPC custody
      _broadcastStream(msg);   // relay to dashboard + other stream subscribers
    } catch (_) {}
  });
});

const _bridgeHttpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost`);

  if (req.method === "GET" && url.pathname === "/api/v1/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok:         true,
      uptime_ms:  Math.round(process.uptime() * 1000),
      workers:    Object.keys(_workers).length,
      timestamp:  Date.now(),
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/intent") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const intent = JSON.parse(body);
        if (_phic.execution_disabled) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: "execution_disabled" }));
          return;
        }
        // Mirror echoforge_worker's execution_intent path — enrich with live price + cached p_up
        const cached = _inferenceCache.get(intent.pattern_id + ":" + (intent.regime_tag || "LowVol"));
        _workers.execution?.postMessage({
          type:         "execution_intent",
          ...intent,
          market_price: _lastPrice || intent.market_price || 0,
          p_up:         cached?.p_up ?? intent.p_up ?? 0.55,
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/session/corpus") {
    try {
      const days    = Math.min(parseInt(url.searchParams.get("lookback_days") || "7", 10), 90);
      const type    = url.searchParams.get("type") || null;
      const stats   = url.searchParams.get("stats") === "true";
      const cutoff  = Date.now() - days * 86_400_000;

      if (stats) {
        const row = _corpusDb.query(
          "SELECT COUNT(*) AS total, COUNT(DISTINCT session_id) AS sessions FROM echoforge_sessions WHERE ts >= ?"
        ).get(cutoff);
        const types = _corpusDb.query(
          "SELECT type, COUNT(*) AS n FROM echoforge_sessions WHERE ts >= ? GROUP BY type"
        ).all(cutoff);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ total_records: row.total, sessions: row.sessions, by_type: types }));
      } else {
        const where = type ? "WHERE ts >= ? AND type = ?" : "WHERE ts >= ?";
        const args  = type ? [cutoff, type] : [cutoff];
        const rows  = _corpusDb.query(
          `SELECT session_id, tab_id, ts, type, payload FROM echoforge_sessions ${where} ORDER BY ts DESC LIMIT 50000`
        ).all(...args);
        const parsed = rows.map(r => { try { return { ...r, payload: JSON.parse(r.payload) }; } catch { return r; } });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ records: parsed, count: parsed.length }));
      }
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/session/commit") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const { session_id, tab_id, records } = JSON.parse(body);
        if (!Array.isArray(records) || !session_id) {
          res.writeHead(400); res.end(JSON.stringify({ error: "session_id and records[] required" }));
          return;
        }
        const rows = records.map(r => ({
          session_id,
          tab_id:  tab_id || "unknown",
          ts:      r.ts || Date.now(),
          type:    r.type || "unknown",
          payload: typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload ?? r),
        }));
        _corpusInsertMany(rows);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, inserted: rows.length }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/v1/phic/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(_phic));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/phic/config") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const config = JSON.parse(body);
        _phic = { ..._phic, ...config };
        for (const w of Object.values(_workers)) w.postMessage({ type: "phic_update", config: _phic });
        _ipcSend({ type: "phic_update", config: _phic });
        _broadcastPhic({ type: "phic_update", config: _phic });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/phic/freeze") {
    const freeze = { emergency_freeze: true };
    _phic = { ..._phic, ...freeze };
    for (const w of Object.values(_workers)) w.postMessage({ type: "phic_update", config: freeze });
    _ipcSend({ type: "emergency_freeze" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Adapt endpoints (daemon-only JS implementations) ──────────────────────
  if (req.method === "POST" && url.pathname.startsWith("/api/v1/adapt/")) {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }

      if (url.pathname === "/api/v1/adapt/calibrate-thresholds") {
        const samples = (data.samples || []).map(Number).filter(v => !isNaN(v) && v >= 0 && v <= 1);
        if (samples.length < 30) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Need at least 30 samples" }));
          return;
        }
        samples.sort((a, b) => a - b);
        const pct = (p) => {
          const idx = (p / 100) * (samples.length - 1);
          const lo  = Math.floor(idx), hi = Math.ceil(idx);
          return +(samples[lo] + (samples[hi] - samples[lo]) * (idx - lo)).toFixed(4);
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          vpin_highvol_threshold: pct(75),
          vpin_crisis_threshold:  pct(95),
          sample_count: samples.length,
          p25: pct(25), p50: pct(50), p75: pct(75), p90: pct(90), p95: pct(95), p99: pct(99),
        }));

      } else if (url.pathname === "/api/v1/adapt/tune-decay") {
        const session      = data.session  || {};
        const decisions    = session.decisions || [];
        const outcomes     = session.outcomes  || [];
        const decayRange   = data.decay_range   || [0.005, 0.20, 12];
        const lossRange    = data.loss_range    || [2.0,  10.0, 12];
        const survivalFloor = data.survival_floor ?? 0.30;
        const topN         = data.top_n ?? 5;

        if (!decisions.length) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no decisions in session", best: null, top: [] }));
          return;
        }

        const MIN_ALIVENESS = 0.30;
        const SIGNAL_BOOST  = 0.03;

        const linspace = (lo, hi, n) => {
          n = Math.round(n);
          if (n <= 1) return [lo];
          return Array.from({ length: n }, (_, i) => lo + (hi - lo) / (n - 1) * i);
        };

        const simulate = (decayRate, lossMult) => {
          // Build FIFO outcome scores per pattern
          const fifo = new Map();
          for (const o of outcomes) {
            const pid = o.pattern_id;
            const sc  = o.outcome_score;
            if (pid != null && sc != null) {
              if (!fifo.has(pid)) fifo.set(pid, []);
              fifo.get(pid).push(parseFloat(sc));
            }
          }
          let aliveness = 0.50;
          const scores = [];
          let passed = 0, dropped = 0;
          for (const d of decisions) {
            if (d.result !== "pass") { dropped++; continue; }
            aliveness = Math.min(1.0, aliveness + SIGNAL_BOOST);
            if (aliveness < MIN_ALIVENESS) { dropped++; continue; }
            passed++;
            const pid = d.pattern_id;
            const q   = fifo.get(pid);
            if (q && q.length > 0) {
              const sc      = q.shift();
              scores.push(sc);
              const norm    = (sc + 1.0) / 2.0;
              const alpha   = sc < 0 ? Math.min(decayRate * lossMult, 1.0) : decayRate;
              aliveness     = Math.max(0.0, Math.min(1.0, aliveness * (1 - alpha) + norm * alpha));
            }
          }
          const total    = passed + dropped;
          const passRate = total > 0 ? passed / total : 0;
          const winRate  = scores.length > 0 ? scores.filter(s => s > 0).length / scores.length : 0;
          const mean     = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
          const variance = scores.length > 0 ? scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length : 0;
          const sharpe   = variance > 0 ? mean / Math.sqrt(variance) : 0;
          return {
            decay_rate:      +decayRate.toFixed(6),
            loss_multiplier: +lossMult.toFixed(6),
            sharpe:          +sharpe.toFixed(6),
            win_rate:        +winRate.toFixed(6),
            pass_rate:       +passRate.toFixed(6),
            echo_survival:   aliveness >= MIN_ALIVENESS ? 1.0 : 0.0,
            executions:      scores.length,
          };
        };

        const decayVals  = linspace(decayRange[0], decayRange[1], decayRange[2]);
        const lossVals   = linspace(lossRange[0],  lossRange[1],  lossRange[2]);
        const allResults = [];
        for (const dr of decayVals) for (const lm of lossVals) allResults.push(simulate(dr, lm));

        let viable = allResults.filter(r => r.echo_survival >= survivalFloor && r.executions > 0);
        if (!viable.length) viable = allResults.filter(r => r.executions > 0);
        if (!viable.length) viable = allResults;
        viable.sort((a, b) => b.sharpe - a.sharpe);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          best:       viable[0] || null,
          top:        viable.slice(0, topN),
          grid_cells: allResults.length,
          decisions:  decisions.length,
          outcomes:   outcomes.length,
        }));

      } else if (url.pathname === "/api/v1/adapt/retrain") {
        // If request body is empty, substitute the corpus outcome log (last 7 days).
        // This lets the browser call retrain with no payload and still get a full corpus fit.
        let fills = Array.isArray(data) ? data : [];
        if (fills.length === 0) {
          const cutoff = Date.now() - 7 * 86_400_000;
          const rows   = _corpusDb.query(
            "SELECT payload FROM echoforge_sessions WHERE type = 'outcome' AND ts >= ? ORDER BY ts DESC LIMIT 5000"
          ).all(cutoff);
          fills = rows.map(r => { try { return JSON.parse(r.payload); } catch { return null; } }).filter(Boolean);
          console.info("[corpus] retrain: using %d corpus outcomes (last 7d)", fills.length);
        }
        // If still empty, return existing model unchanged (no training data yet)
        if (fills.length === 0) {
          const modelPath = path.join(BROWSER_DIR, "models", "signal_model.onnx");
          fs.readFile(modelPath, (err, buf) => {
            if (err) { res.writeHead(500); res.end(JSON.stringify({ error: "no training data and model not found" })); return; }
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(buf);
          });
          return;
        }
        // Proxy corpus to Python bridge for actual ML fit (sklearn + skl2onnx)
        const _exchangeBase2 = process.env.ECHOFORGE_EXCHANGE_URL || "http://localhost:8766";
        const _fallbackModel = (errMsg) => {
          console.warn("[runner] retrain fallback — returning bundled model (%s)", errMsg);
          const modelPath = path.join(BROWSER_DIR, "models", "signal_model.onnx");
          fs.readFile(modelPath, (err, buf) => {
            if (err) { res.writeHead(500); res.end(JSON.stringify({ error: "retrain unavailable" })); return; }
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(buf);
          });
        };
        fetch(_exchangeBase2 + "/mock/retrain", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fills),
        }).then(async r => {
          if (r.ok) {
            const buf = Buffer.from(await r.arrayBuffer());
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(buf);
          } else {
            // Python bridge returned an error (e.g. sklearn failure) — fall back to bundled model
            _fallbackModel(`HTTP ${r.status}`);
          }
        }).catch((err) => _fallbackModel(err.message));
        return;

      } else if (url.pathname === "/api/v1/adapt/pretrain-historical") {
        // Proxy to mock_valr / Python bridge — requires Binance klines + sklearn/skl2onnx
        const _exchangeBase = process.env.ECHOFORGE_EXCHANGE_URL || "http://localhost:8766";
        let _body = "";
        req.on("data", c => _body += c);
        req.on("end", async () => {
          try {
            const upResp = await fetch(_exchangeBase + "/mock/pretrain-historical", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    _body || "{}",
            });
            const result = await upResp.text();
            res.writeHead(upResp.status, { "Content-Type": "application/json" });
            res.end(result);
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ onnx_b64: null, error: `Pretrain unavailable: ${err.message}` }));
          }
        });
        return;

      } else if (url.pathname === "/api/v1/adapt/discover") {
        // Requires Ollama — not available in daemon-only mode.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ discoveries: [] }));

      } else {
        res.writeHead(404); res.end("Not found");
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

_bridgeHttpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/v1/phic/ws") {
    _wssPhic.handleUpgrade(req, socket, head, (ws) => _wssPhic.emit("connection", ws, req));
  } else if (url.pathname === "/api/v1/metrics") {
    _wssMetrics.handleUpgrade(req, socket, head, (ws) => _wssMetrics.emit("connection", ws, req));
  } else if (url.pathname === "/api/v1/tick") {
    _wssTick.handleUpgrade(req, socket, head, (ws) => _wssTick.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── 4. Spawn workers ───────────────────────────────────────────────────────
function _spawnWorker(relPath, workerData = {}) {
  const absPath = path.join(BROWSER_DIR, relPath);
  const w = new Worker(absPath, {
    workerData,
    // Pass SAB as initial data (worker_threads auto-serializes SharedArrayBuffer)
    resourceLimits: {},
  });
  w.on("error", (err) => console.error(`[runner] Worker ${relPath} error:`, err.message));
  w.on("exit",  (code) => {
    if (code !== 0) console.warn(`[runner] Worker ${relPath} exited with code ${code}`);
  });
  return w;
}

// execution_worker needs globalThis.indexedDB — use a wrapper entry that sets
// the shim before importing the worker so each worker_thread gets its own copy.
const EXECUTION_ENTRY = path.resolve(__dirname, "workers/execution_entry.js");

const _workers = {
  orderbook:   _spawnWorker("workers/orderbook_worker.js"),
  nociceptor:  _spawnWorker("workers/nociceptor_worker.js"),
  echoforge:   _spawnWorker("workers/echoforge_worker.js"),
  execution:   new Worker(EXECUTION_ENTRY, { workerData: {} }),
  inference:   _spawnWorker("workers/inference_worker.js"),
  correlation: _spawnWorker("workers/correlation_worker.js"),
};

_workers.execution.on("error", (err) => console.error("[runner] Worker execution_entry.js error:", err.message));
_workers.execution.on("exit",  (code) => {
  if (code !== 0) {
    console.warn("[runner] Worker execution_entry.js exited with code", code, "— restarting");
    _workers.execution = new Worker(EXECUTION_ENTRY, { workerData: {} });
    _workers.execution.on("error", (e) => console.error("[runner] Worker execution_entry.js error:", e.message));
    _workers.execution.on("exit",  (c) => { if (c !== 0) console.warn("[runner] execution_entry.js exited with code", c); });
    _workers.execution.postMessage({
      type: "init", phic: _phic,
      exchange_config: { api_url: EXCHANGE_URL, symbol: "BTC/USDT" },
    });
    _wireExecutionMessages();
  }
});

// Initialise workers
_workers.orderbook.postMessage({ type: "init", sab });
_workers.nociceptor.postMessage({ type: "init", sab, phic: _phic });
_workers.echoforge.postMessage({ type: "init", phic: _phic });
_workers.execution.postMessage({
  type: "init",
  phic: _phic,
  exchange_config: { api_url: EXCHANGE_URL, symbol: "BTC/USDT" },
});
_workers.inference.postMessage({ type: "init" });
_workers.correlation.postMessage({ type: "init" });

console.info("[runner] 6 workers started");

// Start browser-facing API server now that _workers is fully initialised.
_bridgeHttpServer.listen(BRIDGE_PORT, () =>
  console.info(`[bridge-api] HTTP+WS ready on :${BRIDGE_PORT}`)
);

// Connect to NATS JetStream (non-blocking; daemon is healthy without it)
_natsConnect();

// ── 5. Inter-worker message routing (mirrors index.html) ──────────────────

_workers.orderbook.on("message", (msg) => {
  if (msg.type === "tick") {
    _workers.nociceptor?.postMessage({ type: "latency_sample",
      latency_ms: Date.now() - (msg.timestamp || Date.now()), clock_skew_ms: 0 });
    if (msg.price > 0) {
      // Always forward to correlation_worker (needs all symbols for cross-pair metrics)
      _workers.correlation?.postMessage({ type: "tick", ...msg, exchange: "VALR" });

      // All BTC-specific logic below — ignore ETH/SOL ticks from multi-pair mock feed
      if (msg.symbol && msg.symbol !== "BTCUSDT") return;

      _lastPrice = msg.price;
      if (msg.ema_fast)            _lastMarket.ema_fast = msg.ema_fast;
      if (msg.ema_slow)            _lastMarket.ema_slow = msg.ema_slow;
      if (msg.momentum !== undefined) _lastMarket.momentum = msg.momentum;
      _workers.echoforge?.postMessage({ type: "price_tick", price: msg.price, spread: msg.spread || 0 });
      _workers.execution?.postMessage({ type: "price_tick", price: msg.price });

      // ── SuperTrend cross detection → SUPERTREND_CROSS signal ─────────────
      const price = msg.price;
      if (_stPrevPrice > 0) {
        const tr = Math.abs(price - _stPrevPrice);
        _stATR   = _stATR === 0 ? tr : _stATR * (1 - ST_ALPHA) + tr * ST_ALPHA;
      }
      _stPrevPrice = price;
      if (_stATR > 0) {
        const upper  = price + ST_MULT * _stATR;
        const lower  = price - ST_MULT * _stATR;
        const prev   = _stLine;
        if (_stDir === 0) {
          _stDir = 1; _stLine = lower;
        } else if (_stDir === 1) {
          _stLine = Math.max(prev, lower);
          if (price < _stLine) {
            _stDir = -1; _stLine = upper;
            const nowST = Date.now();
            if (nowST - _stLastFlipAt >= ST_FLIP_COOLDOWN_MS) {
              _stLastFlipAt = nowST;
              const slip = msg.spread > 0 ? msg.spread / price / 2 : _makerFee * 0.05;
              _workers.nociceptor?.postMessage({ type: "signal", pattern_id: "SUPERTREND_CROSS",
                gross_delta: -0.004, maker_fee: _makerFee, taker_fee: _takerFee,
                slippage: slip, regime_tag: _regime });
              console.info("[runner] SUPERTREND_CROSS bearish flip @ $%s regime=%s", price.toFixed(2), _regime);
            }
          }
        } else {
          _stLine = Math.min(prev, upper);
          if (price > _stLine) {
            _stDir = 1; _stLine = lower;
            const nowST = Date.now();
            if (nowST - _stLastFlipAt >= ST_FLIP_COOLDOWN_MS) {
              _stLastFlipAt = nowST;
              const slip = msg.spread > 0 ? msg.spread / price / 2 : _makerFee * 0.05;
              _workers.nociceptor?.postMessage({ type: "signal", pattern_id: "SUPERTREND_CROSS",
                gross_delta: 0.004, maker_fee: _makerFee, taker_fee: _takerFee,
                slippage: slip, regime_tag: _regime });
              console.info("[runner] SUPERTREND_CROSS bullish flip @ $%s regime=%s", price.toFixed(2), _regime);
            }
        }
      }
      } // end if (_stATR > 0)

      // ── Whale Wake detection → WHALE_WAKE signal ─────────────────────────
      // Uses flow EWMA (buy_volume / sell_volume from orderbook_worker ring buffer),
      // not L2 book depth, for directional signal — same logic as index.html.
      const flowTotal = (msg.buy_volume || 0) + (msg.sell_volume || 0);
      const flowImbal = flowTotal > 0
        ? ((msg.buy_volume || 0) - (msg.sell_volume || 0)) / flowTotal : 0;
      const whaleDetected = (msg.twap_score ?? 1) < 0.15 || (msg.vwap_anchor ?? 0) > 0.80;
      const now = Date.now();
      // In a confirmed downtrend raise the buy-flow conviction bar to 0.25 (vs 0.10)
      // to avoid riding dead-cat bounces or buy-side spoofing in a falling market.
      const wTrend    = _lastMarket.ema_slow > 0
        ? (_lastMarket.ema_fast - _lastMarket.ema_slow) / _lastMarket.ema_slow : 0;
      const wBuyThreshold = (flowImbal > 0 && wTrend < -0.002) ? 0.25 : 0.10;
      if (whaleDetected && Math.abs(flowImbal) > wBuyThreshold && now - _lastWhaleEmitAt > 10_000) {
        _lastWhaleEmitAt = now;
        const slip = msg.spread > 0 ? msg.spread / price / 2 : _makerFee * 0.05;
        _workers.nociceptor?.postMessage({ type: "signal", pattern_id: "WHALE_WAKE",
          gross_delta: flowImbal > 0 ? 0.004 : -0.004, maker_fee: _makerFee, taker_fee: _takerFee,
          slippage: slip, regime_tag: "Any" });
        console.info("[runner] WHALE_WAKE twap=%s vwap_anchor=%s flow=%s dir=%s trend=%s",
          (msg.twap_score ?? "?"), (msg.vwap_anchor ?? "?"), flowImbal.toFixed(3),
          flowImbal > 0 ? "BUY" : "SELL", wTrend.toFixed(4));
      }
    }
  } else if (msg.type === "ofi_snapshot") {
    _workers.inference?.postMessage({ type: "ofi_infer", features: msg.features });
  } else if (msg.type === "depth_update") {
    _broadcastStream(msg);
  } else if (msg.type === "depth_alert") {
    _ipcSend({ type: "sentinel_alert", sentinel_type: "DepthAlert", ...msg });
  }
});

_workers.nociceptor.on("message", (msg) => {
  switch (msg.type) {
    case "vpin_update":
      // Enrich with latency + momentum so RegimeDetector gets a full observation
      _ipcSend({ ...msg, latency_ms: _exchangeLatencyMs ?? 10, momentum: _lastMarket.momentum });
      _broadcastStream(msg);
      break;
    case "sentinel_alert":
      _ipcSend(msg);
      _broadcastStream(msg);
      break;
    case "signal_pass":
      _workers.echoforge?.postMessage({ type: "signal_pass", ...msg });
      break;
    case "signal_drop":
      break;
    case "pain_map":
      // Broadcast to echoforge (self) — in daemon no mesh peers, but self-routing is valid
      _workers.echoforge?.postMessage({ type: "pain_map", ...msg, node_id: "daemon" });
      _ipcSend({ type: "pain_map", ...msg });
      break;
    case "latency_report":
      _exchangeLatencyMs = msg.exchange_latency_ms ?? _exchangeLatencyMs;
      _workers.echoforge?.postMessage({ type: "latency_report", ...msg });
      break;
  }
});

// Patterns that self-emit from orderbook detection — don't forward inference results
// to nociceptor or would double-signal on the same tick
const _INFERENCE_DISPLAY_ONLY = new Set(["WHALE_WAKE", "SUPERTREND_CROSS"]);

_workers.echoforge.on("message", (msg) => {
  switch (msg.type) {
    case "execution_intent": {
      // Observatory mode: echoes evolve, VPIN flows, but no orders are placed
      if (_phic.execution_disabled) break;
      const _cached = _inferenceCache.get(msg.pattern_id + ":" + (msg.regime_tag || "LowVol"));
      _workers.execution?.postMessage({
        type: "execution_intent", ...msg,
        market_price: _lastPrice,   // real price from latest orderbook tick — never 0 after first tick
        p_up: _cached?.p_up ?? 0.55,
      });
      break;
    }
    case "echo_snapshot":
      _ipcSend(msg);
      _broadcastStream(msg);
      break;
    case "pattern_veto":
      _workers.execution?.postMessage({ type: "pattern_veto", ...msg });
      break;
    case "toxic_state_snapshot":
      _natsPublish("echoforge.forensic.snapshot", { ...msg, ts: Date.now() });
      _ipcSend(msg);
      _broadcastStream(msg);
      break;
    case "sentinel_alert":
      _ipcSend(msg);
      _broadcastStream(msg);
      break;
    case "hurdle_suggestion":
      // Broadcast to browser PHIC panel so it can render the metabolic insights
      _broadcastStream(msg);
      break;
  }
});

function _wireExecutionMessages() {
  _workers.execution.on("message", (msg) => {
    switch (msg.type) {
      case "fill":
        _natsPublish("echoforge.execution.fill", { ...msg, ts: Date.now() });
        _ipcSend(msg);
        _broadcastStream(msg);
        break;
      case "order_intent":
      case "cashout_complete":
        _ipcSend(msg);
        _broadcastStream(msg);
        break;
      case "killswitch_snapshot":
        _natsPublish("echoforge.forensic.killswitch", { ...msg, ts: Date.now() });
        _ipcSend(msg);
        _broadcastStream(msg);
        break;
      case "order_submitted":
      case "portfolio_update":
        // Update local portfolio mirror and forward position context to echoforge
        if (msg.portfolio) Object.assign(_portfolio, msg.portfolio);
        if (msg.btc       != null) _portfolio.btc            = msg.btc;
        if (msg.avg_cost  != null) _portfolio.avg_cost        = msg.avg_cost;
        if (msg.unrealized_pnl != null) _portfolio.unrealized_pnl = msg.unrealized_pnl;
        if (msg.total_value    != null) _portfolio.total_value     = msg.total_value;
        _workers.echoforge?.postMessage({
          type:           "position_update",
          btc:            _portfolio.btc,
          avg_cost:       _portfolio.avg_cost,
          unrealized_pnl: _portfolio.unrealized_pnl,
          total_value:    _portfolio.total_value,
        });
        _ipcSend(msg);
        _broadcastStream(msg);
        if (msg.type === "order_submitted" && msg.side) {
          const pnl = msg.pnl_realized ?? 0;
          console.info("[runner] %s %s qty=%s @ $%s pnl=%s%s",
            msg.side.toUpperCase(), msg.pattern_id || "?",
            (msg.qty || 0).toFixed(6), (msg.filled_price || 0).toFixed(2),
            pnl >= 0 ? "+" : "", pnl.toFixed(2));
        }
        break;
      case "execution_result":
        _workers.echoforge?.postMessage({ type: "execution_result", ...msg });
        break;
      case "execution_stats":
        _workers.echoforge?.postMessage({ type: "execution_stats", ...msg });
        break;
      case "retrain_ready":
        _workers.inference?.postMessage({ type: "infer", ...msg });
        break;
    }
  });
}
_wireExecutionMessages();

_workers.inference.on("message", (msg) => {
  switch (msg.type) {
    case "inference_ready":
      console.info("[runner] Inference model ready (retrained=%s)", msg.retrained || false);
      break;
    case "inference_result":
      // Cache p_up so execution_intent can be Kelly-scaled (keyed by pattern:regime)
      _inferenceCache.set(msg.pattern_id + ":" + (msg.regime_tag || "LowVol"), { p_up: msg.p_up });
      // Forward to browser observe mode and dashboard AI signal display
      _broadcastStream(msg);
      // Self-emitting patterns signal on detection — skip nociceptor forward to avoid duplicates
      if (!_INFERENCE_DISPLAY_ONLY.has(msg.pattern_id)) {
        // ── Trend filter (mirrors browser _onInferenceMsg logic) ───────────────
        const { ema_fast, ema_slow, momentum } = _lastMarket;
        const trendStrength = ema_slow > 0 ? (ema_fast - ema_slow) / ema_slow : 0;
        const buySignal     = msg.gross_delta > 0;
        let   _trendAllow   = true;

        if (Math.abs(trendStrength) > 0.002) {
          const trendDown = trendStrength < 0;
          const trendUp   = trendStrength > 0;
          switch (msg.pattern_id) {
            case "REVERSION_A":
              if (buySignal  && trendDown) _trendAllow = false;
              if (!buySignal && trendUp)   _trendAllow = false;
              break;
            case "MOMENTUM_V1":
              if (buySignal  && trendDown && momentum < 0) _trendAllow = false;
              if (!buySignal && trendUp   && momentum > 0) _trendAllow = false;
              break;
            case "DEPTH_GRAB":
              if (buySignal  && trendDown && momentum < 0) _trendAllow = false;
              if (!buySignal && trendUp   && momentum > 0) _trendAllow = false;
              break;
            case "SPREAD_FADE":
              if (buySignal  && trendDown) _trendAllow = false;
              if (!buySignal && trendUp)   _trendAllow = false;
              break;
          }
        }

        if (_trendAllow) _workers.nociceptor?.postMessage({ type: "signal", ...msg });
      }
      break;
    case "ofi_result":
      _ipcSend({ type: "ofi_update", ofi_bias: msg.ofi_bias, confidence: msg.confidence,
        timestamp: msg.timestamp });
      _broadcastStream({ type: "ofi_update", ofi_bias: msg.ofi_bias, confidence: msg.confidence,
        timestamp: msg.timestamp });
      break;
    case "inference_error":
      console.error("[runner] Inference error:", msg.error);
      break;
  }
});

_workers.correlation.on("message", (msg) => {
  if (msg.type === "cross_pair_signal") {
    _workers.echoforge?.postMessage({ type: "cross_pair_signal", ...msg });
    _ipcSend({ type: "correlation_signal", ...msg });
  } else if (msg.type === "arb_detected") {
    const slippage = _lastPrice > 0 ? 0.0001 : 0.001;
    _workers.nociceptor?.postMessage({
      type:        "signal",
      pattern_id:  "ARBI_CROSS_EXCHANGE",
      gross_delta: msg.exchange_lag_ms > 0 ? 0.005 : -0.005,
      maker_fee:   _makerFee,
      taker_fee:   _takerFee,
      slippage,
      regime_tag:  _regime,
    });
    _ipcSend({ type: "arb_signal", ...msg });
  }
});

// ── 6. Exchange adapters ──────────────────────────────────────────────────

// VALR: primary execution venue — routes to orderbook_worker for ring-buffer VPIN
const _adapter = new VALRWebSocketAdapter(WS_URL, (msg) => {
  _workers.orderbook?.postMessage(msg);
});
_adapter.start();

// Binance: price-discovery feed only — routes to correlation_worker for lead-lag detection
// No orderbook maintained; Binance ticks never touch the ring buffer or execution path.
const BINANCE_URL = process.env.ECHOFORGE_BINANCE_URL ?? null;
const _binanceAdapter = new BinanceWebSocketAdapter(BINANCE_URL, (msg) => {
  _workers.correlation?.postMessage({ type: "tick", ...msg });
});
_binanceAdapter.start();

// ── 7. IPC WebSocket server (:ECHOFORGE_IPC_PORT) ─────────────────────────

const _wss = new WebSocketServer({ port: IPC_PORT });
console.info(`[ipc] WS ready on :${IPC_PORT}`);

_wss.on("connection", (ws) => {
  console.info("[ipc] Python host connected");
  _ipcSocket = ws;

  // Replay current PHIC + regime to newly connected host
  if (Object.keys(_phic).length > 0) {
    try { ws.send(JSON.stringify({ type: "sync_state", phic_config: _phic, last_regime: _regime })); } catch (_) {}
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (msg.type) {
      case "phic_update":
        _phic = { ..._phic, ...(msg.config || {}) };
        for (const w of Object.values(_workers)) {
          w.postMessage({ type: "phic_update", config: msg.config });
        }
        _broadcastPhic({ type: "phic_update", config: _phic });
        _natsPublish("echoforge.phic.update", { config: _phic, ts: Date.now() });
        // If the Navigator embedded a regime_forecast in proactive_overrides, also
        // update _regime so logs/heartbeats reflect the HMM-inferred state.
        {
          const forecast = msg.config?.proactive_overrides?.regime_forecast;
          if (forecast) {
            _regime = forecast;
            for (const w of Object.values(_workers)) {
              w.postMessage({ type: "regime_change", regime_tag: _regime });
            }
          }
        }
        break;
      case "regime_change":
        _regime = msg.regime_tag || _regime;
        for (const w of Object.values(_workers)) {
          w.postMessage({ type: "regime_change", regime_tag: _regime });
        }
        break;
      case "reload_model":
        _workers.inference?.postMessage(msg);
        break;
      case "reload_ofi_model":
        _workers.inference?.postMessage(msg);
        break;
      case "sentiment_update":
        // Forward to all workers — inference_worker uses it in feature vector construction
        for (const w of Object.values(_workers)) w.postMessage(msg);
        break;
      case "cashout":
        // Flatten all positions — freeze first, then pass to execution_worker
        _phic = { ..._phic, emergency_freeze: true };
        for (const w of Object.values(_workers)) w.postMessage({ type: "phic_update", config: { emergency_freeze: true } });
        _workers.execution?.postMessage({ type: "cashout" });
        break;
      case "sync_state":
        // Python host sending state after reconnect — apply PHIC + regime
        if (msg.phic_config) {
          _phic = { ..._phic, ...msg.phic_config };
          for (const w of Object.values(_workers)) {
            w.postMessage({ type: "phic_update", config: msg.phic_config });
          }
        }
        if (msg.last_regime) {
          _regime = msg.last_regime;
          for (const w of Object.values(_workers)) {
            w.postMessage({ type: "regime_change", regime_tag: _regime });
          }
        }
        break;
    }
  });

  ws.on("close", () => {
    console.warn("[ipc] Python host disconnected");
    if (_ipcSocket === ws) _ipcSocket = null;
  });

  ws.on("error", (err) => console.error("[ipc] WS error:", err.message));
});

// ── 8. Heartbeat loop (JS → Python, every 30s) ────────────────────────────
// Lets Python detect silent daemon failure and restart the subprocess.

setInterval(() => {
  _ipcSend({
    type:           "heartbeat",
    workers_active: Object.keys(_workers).length,
    uptime_ms:      process.uptime() * 1000,
    timestamp:      Date.now(),
  });
}, HEARTBEAT_MS);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.info("[runner] SIGTERM — shutting down");
  _adapter.stop();
  _wss.close();
  _bridgeHttpServer.close();
  for (const w of Object.values(_workers)) w.terminate();
  if (_natsConn) _natsConn.drain().catch(() => {}).finally(() => process.exit(0));
  else process.exit(0);
});
