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

import { groupDistributions } from "./utils/stats.js";

const DB_NAME    = "echoforge_sessions";
const DB_VERSION = 1;

// Tick sample rate — 1 per second prevents GB-scale storage on 7-day runs
const TICK_SAMPLE_INTERVAL_MS = 1_000;

// Max records kept per store in ring-buffer mode (activated at >75% quota usage)
const RING_MAX_OUTCOMES   = 10_000;
const RING_MAX_DECISIONS  = 5_000;
const RING_MAX_TICKS      = 20_000;
const QUOTA_CHECK_INTERVAL_MS = 5 * 60_000;  // every 5 min

class SessionRecorder {
  constructor() {
    this._db          = null;
    this._sessionId   = null;
    this._startedAt   = null;
    this._phicHash    = null;
    this._lastTickAt  = 0;
    this._ready       = false;
    this._mode        = "normal";   // "normal" | "ring_buffer"
    this._quotaPct    = 0;          // last measured storage quota usage [0–1]
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
    // Periodic storage quota check — prune non-critical records if usage exceeds 75%
    setInterval(() => this._checkQuota(), QUOTA_CHECK_INTERVAL_MS);
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

    // Per-(pattern,regime) distribution summary — consumed by decay_tuner.py and
    // the PHIC dashboard box plot tab. Computed at export time so the raw outcomes
    // array stays compact throughout the session.
    const decisiveOutcomes    = outcomes.filter(o => o.decisive === true);
    const decisive_count      = decisiveOutcomes.length;
    const non_decisive_count  = outcomes.filter(o => o.decisive === false).length;
    const distributions           = groupDistributions(outcomes);
    const decisive_distributions  = groupDistributions(decisiveOutcomes);

    return {
      session_id:   sid,
      started_at:   this._startedAt,
      exported_at:  Date.now(),
      phic_hash:    this._phicHash,
      ticks,
      decisions,
      outcomes,
      events,
      distributions,
      decisive_distributions,
      decisive_count,
      non_decisive_count,
    };
  }

  async stats(sessionId = null) {
    const session = await this.exportSession(sessionId);
    if (!session) return null;

    const { decisions, outcomes, events, decisive_count, non_decisive_count } = session;

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
      session_id:        session.session_id,
      duration_ms:       Date.now() - session.started_at,
      ticks_sampled:     session.ticks.length,
      signals_passed:    passed,
      signals_dropped:   dropped,
      pass_rate:         passed / ((passed + dropped) || 1),
      executions:        executed.length,
      decisive_count,
      non_decisive_count,
      win_rate:          +winRate.toFixed(4),
      sharpe:            +sharpe.toFixed(4),
      echo_survival:     totalEchoes > 0 ? +(aliveEchoes / totalEchoes).toFixed(4) : 0,
      sentinels:         bySentinel,
      quota_pct:         +this._quotaPct.toFixed(3),
      recorder_mode:     this._mode,
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

  // ── Storage quota management ─────────────────────────────────────────────────

  async _checkQuota() {
    if (!navigator.storage?.estimate) return;
    try {
      const est = await navigator.storage.estimate();
      this._quotaPct = est.usage / (est.quota || 1);
      // Broadcast so the dashboard can update its quota indicator
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("session_quota_update", {
          detail: { quotaPct: this._quotaPct, mode: this._mode }
        }));
      }
      if (this._quotaPct > 0.75) {
        console.warn(`[session] quota at ${(this._quotaPct * 100).toFixed(1)}% — pruning non-critical records`);
        await this._pruneForQuota();
        this._mode = "ring_buffer";
      }
    } catch (err) {
      console.warn("[session] quota check failed:", err);
    }
  }

  async _pruneForQuota() {
    // Prune order: non-decisive outcomes → decisive outcomes → decisions → ticks.
    // SAF records live in the daemon's SQLite, not here — nothing to skip.
    const nonDecisiveCount = await this._countWhere("outcomes", o => o.decisive === false);
    if (nonDecisiveCount > 0) {
      await this._pruneOldest("outcomes", nonDecisiveCount, r => r.decisive === false);
    }
    // If still over budget, prune decisive outcomes keeping newest 5k
    const outcomeCount = await this._countStore("outcomes");
    if (outcomeCount > RING_MAX_OUTCOMES) {
      await this._pruneOldestN("outcomes", outcomeCount - RING_MAX_OUTCOMES);
    }
    const decisionCount = await this._countStore("decisions");
    if (decisionCount > RING_MAX_DECISIONS) {
      await this._pruneOldestN("decisions", decisionCount - RING_MAX_DECISIONS);
    }
    const tickCount = await this._countStore("ticks");
    if (tickCount > RING_MAX_TICKS) {
      await this._pruneOldestN("ticks", tickCount - RING_MAX_TICKS);
    }
    console.info("[session] pruning complete");
  }

  _countStore(storeName) {
    return new Promise((resolve) => {
      try {
        const tx  = this._db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror   = () => resolve(0);
      } catch { resolve(0); }
    });
  }

  _countWhere(storeName, predicate) {
    return new Promise((resolve) => {
      try {
        const tx  = this._db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).openCursor();
        let count = 0;
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) { if (predicate(cursor.value)) count++; cursor.continue(); }
          else resolve(count);
        };
        req.onerror = () => resolve(0);
      } catch { resolve(0); }
    });
  }

  // Delete all records matching predicate (oldest first via timestamp index)
  _pruneOldest(storeName, limit, predicate) {
    return new Promise((resolve) => {
      try {
        const tx    = this._db.transaction(storeName, "readwrite");
        const index = tx.objectStore(storeName).index("timestamp");
        const req   = index.openCursor();
        let deleted = 0;
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor && deleted < limit) {
            if (predicate(cursor.value)) { cursor.delete(); deleted++; }
            cursor.continue();
          } else resolve();
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
  }

  // Delete the N oldest records in a store unconditionally
  _pruneOldestN(storeName, n) {
    return new Promise((resolve) => {
      try {
        const tx    = this._db.transaction(storeName, "readwrite");
        const index = tx.objectStore(storeName).index("timestamp");
        const req   = index.openCursor();
        let deleted = 0;
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor && deleted < n) { cursor.delete(); deleted++; cursor.continue(); }
          else resolve();
        };
        req.onerror = () => resolve();
      } catch { resolve(); }
    });
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
