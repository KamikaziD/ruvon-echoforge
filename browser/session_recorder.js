/**
 * session_recorder.js — IndexedDB session log for replay and decay tuning.
 *
 * Records every signal decision, execution outcome, sentinel alert, and
 * sampled tick. Enables deterministic replay (L2 Replay Gym) and post-session
 * parameter optimisation (Decay Tuner).
 *
 * Usage (main thread):
 *   import { recorder } from "./session_recorder.js";
 *   await recorder.init();
 *   recorder.record("tick",     { price, volume, side, timestamp });
 *   recorder.record("decision", { pattern_id, net_alpha, result, reason });
 *   recorder.record("outcome",  { pattern_id, outcome_score, timestamp });
 *   recorder.record("event",    { kind, detail, timestamp });
 *
 *   const session = await recorder.exportSession();
 *   const stats   = await recorder.stats();
 *   await recorder.clear(olderThanMs);
 *
 * Session export schema:
 *   { session_id, started_at, phic_hash, ticks[], decisions[], outcomes[], events[] }
 */

const DB_NAME    = "echoforge_sessions";
const DB_VERSION = 1;

// Tick sample rate — 1 per second prevents GB-scale storage on 7-day runs
const TICK_SAMPLE_INTERVAL_MS = 1_000;

class SessionRecorder {
  constructor() {
    this._db          = null;
    this._sessionId   = null;
    this._startedAt   = null;
    this._phicHash    = null;
    this._lastTickAt  = 0;
    this._ready       = false;
  }

  async init(phicHash = "unknown") {
    this._sessionId = crypto.randomUUID();
    this._startedAt = Date.now();
    this._phicHash  = phicHash;

    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        for (const [store, opts] of [
          ["ticks",     { autoIncrement: true }],
          ["decisions", { autoIncrement: true }],
          ["outcomes",  { autoIncrement: true }],
          ["events",    { autoIncrement: true }],
        ]) {
          if (!db.objectStoreNames.contains(store)) {
            const s = db.createObjectStore(store, { keyPath: "id", ...opts });
            s.createIndex("session_id", "session_id");
            s.createIndex("timestamp",  "timestamp");
          }
        }
      };
      req.onsuccess = (ev) => resolve(ev.target.result);
      req.onerror   = (ev) => reject(ev.target.error);
    });

    this._ready = true;
    console.info(`[session] started ${this._sessionId.slice(0, 8)} phic=${phicHash}`);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  record(type, data) {
    if (!this._ready) return;

    // Throttle raw ticks to 1/s to keep storage manageable
    if (type === "tick") {
      const now = Date.now();
      if (now - this._lastTickAt < TICK_SAMPLE_INTERVAL_MS) return;
      this._lastTickAt = now;
    }

    const store = this._storeFor(type);
    if (!store) return;

    this._put(store, {
      session_id: this._sessionId,
      timestamp:  data.timestamp || Date.now(),
      ...data,
    });
  }

  async exportSession(sessionId = null) {
    if (!this._db) return null;
    const sid = sessionId || this._sessionId;

    const [ticks, decisions, outcomes, events] = await Promise.all([
      this._getBySession("ticks",     sid),
      this._getBySession("decisions", sid),
      this._getBySession("outcomes",  sid),
      this._getBySession("events",    sid),
    ]);

    return {
      session_id:   sid,
      started_at:   this._startedAt,
      exported_at:  Date.now(),
      phic_hash:    this._phicHash,
      ticks,
      decisions,
      outcomes,
      events,
    };
  }

  async stats(sessionId = null) {
    const session = await this.exportSession(sessionId);
    if (!session) return null;

    const { decisions, outcomes, events } = session;

    // Win rate and fee efficiency
    const executed = outcomes.filter(o => o.outcome_score !== undefined);
    const wins     = executed.filter(o => o.outcome_score > 0);
    const winRate  = executed.length > 0 ? wins.length / executed.length : 0;

    // Sharpe-like ratio (signal: mean outcome / std dev)
    const scores = executed.map(o => o.outcome_score);
    const mean   = scores.reduce((s, v) => s + v, 0) / (scores.length || 1);
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / (scores.length || 1);
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    // Signal pass rate
    const passed  = decisions.filter(d => d.result === "pass").length;
    const dropped = decisions.filter(d => d.result !== "pass").length;

    // Echo survival (alive echoes at last snapshot)
    const snapEvents  = events.filter(e => e.kind === "echo_snapshot");
    const lastSnap    = snapEvents[snapEvents.length - 1];
    const aliveEchoes = lastSnap?.echoes?.filter(e => e.net_aliveness >= 0.30).length ?? 0;
    const totalEchoes = lastSnap?.echoes?.length ?? 0;

    // Sentinel counts
    const sentinels = events.filter(e => e.kind === "sentinel_alert");
    const bySentinel = sentinels.reduce((acc, s) => {
      acc[s.sentinel_type] = (acc[s.sentinel_type] || 0) + 1;
      return acc;
    }, {});

    return {
      session_id:      session.session_id,
      duration_ms:     Date.now() - session.started_at,
      ticks_sampled:   session.ticks.length,
      signals_passed:  passed,
      signals_dropped: dropped,
      pass_rate:       passed / ((passed + dropped) || 1),
      executions:      executed.length,
      win_rate:        +winRate.toFixed(4),
      sharpe:          +sharpe.toFixed(4),
      echo_survival:   totalEchoes > 0 ? +(aliveEchoes / totalEchoes).toFixed(4) : 0,
      sentinels:       bySentinel,
    };
  }

  // Purge sessions older than `olderThanMs` (default: 8 days)
  async clear(olderThanMs = 8 * 24 * 3600 * 1000) {
    if (!this._db) return;
    const cutoff = Date.now() - olderThanMs;
    for (const storeName of ["ticks", "decisions", "outcomes", "events"]) {
      await this._clearOlderThan(storeName, cutoff);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _storeFor(type) {
    const map = { tick: "ticks", decision: "decisions", outcome: "outcomes", event: "events" };
    return map[type] ?? null;
  }

  _put(storeName, record) {
    try {
      const tx  = this._db.transaction(storeName, "readwrite");
      const req = tx.objectStore(storeName).add(record);
      req.onerror = () => {};  // non-fatal — storage quota exceeded is handled silently
    } catch { /* quota errors */ }
  }

  _getBySession(storeName, sessionId) {
    return new Promise((resolve) => {
      try {
        const tx    = this._db.transaction(storeName, "readonly");
        const index = tx.objectStore(storeName).index("session_id");
        const req   = index.getAll(sessionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => resolve([]);
      } catch { resolve([]); }
    });
  }

  _clearOlderThan(storeName, cutoff) {
    return new Promise((resolve) => {
      try {
        const tx    = this._db.transaction(storeName, "readwrite");
        const index = tx.objectStore(storeName).index("timestamp");
        const range = IDBKeyRange.upperBound(cutoff);
        const req   = index.openCursor(range);
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }
}

export const recorder = new SessionRecorder();
