/**
 * indexed-db.js — Bun SQLite shim for execution_worker.js's IDB SAF queue
 *
 * Implements exactly the IndexedDB API surface used by execution_worker.js:
 *   indexedDB.open("echoforge_saf", 1)
 *   store.add(entry) / store.put(entry) / index("status").getAll("PENDING")
 *
 * This is a write-through cache: every new entry also fires an ipc_send()
 * callback so Python's SyncManager gets canonical SAF custody.
 *
 * Bun bundles SQLite — no extra deps needed.
 */

"use strict";

import { Database } from "bun:sqlite";

let _db = null;
let _ipcSend = null;  // (msg) => void — set by runner.js after IPC WS connects

export function setIPCSend(fn) {
  _ipcSend = fn;
}

function _ensureDB() {
  if (_db) return _db;
  _db = new Database(process.env.ECHOFORGE_DB_PATH || "echoforge-edge.db");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS echoforge_saf (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'PENDING',
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saf_status ON echoforge_saf(status);
  `);
  return _db;
}

// ── Minimal IDB shim objects ──────────────────────────────────────────────

class FakeRequest {
  constructor(result) {
    this.result  = result;
    this.error   = null;
    this.onsuccess = null;
    this.onerror   = null;
    // Fire callbacks on next microtask so caller can attach them first
    Promise.resolve().then(() => {
      if (this.onsuccess) this.onsuccess({ target: this });
    });
  }
}

class FakeIndex {
  constructor(store) { this._store = store; }

  getAll(status) {
    const db   = _ensureDB();
    const rows = db.query("SELECT payload FROM echoforge_saf WHERE status = ?").all(status);
    const result = rows.map(r => JSON.parse(r.payload));
    return new FakeRequest(result);
  }
}

class FakeStore {
  index(name) {
    if (name === "status" || name === "queued_at") return new FakeIndex(this);
    throw new Error(`Unknown index: ${name}`);
  }

  add(entry) {
    const db  = _ensureDB();
    const now = Date.now();
    // execution_worker uses entry_id as the IDB keyPath; fall back to id or generate one
    const id  = entry.entry_id || entry.id || crypto.randomUUID();
    const rec = { ...entry, id };
    db.query(
      "INSERT OR IGNORE INTO echoforge_saf (id, status, payload, created_at, updated_at) VALUES (?,?,?,?,?)"
    ).run(id, rec.status || "PENDING", JSON.stringify(rec), now, now);

    // Write-through: notify Python SyncManager for canonical SAF custody
    if (_ipcSend) {
      _ipcSend({ type: "order_intent", ...rec });
    }
    return new FakeRequest(id);
  }

  get(entryId) {
    const db  = _ensureDB();
    const row = db.query("SELECT payload FROM echoforge_saf WHERE id = ?").get(entryId);
    return new FakeRequest(row ? JSON.parse(row.payload) : undefined);
  }

  put(entry) {
    const db  = _ensureDB();
    const now = Date.now();
    // Accept either entry_id (execution_worker keyPath) or id (shim internal key)
    const id  = entry.entry_id || entry.id;
    if (!id) return new FakeRequest(null);
    db.query(
      "UPDATE echoforge_saf SET status = ?, payload = ?, updated_at = ? WHERE id = ?"
    ).run(entry.status || "PENDING", JSON.stringify(entry), now, id);
    return new FakeRequest(id);
  }
}

class FakeTransaction {
  objectStore() { return new FakeStore(); }
}

class FakeIDBDatabase {
  transaction(_storeName, _mode) { return new FakeTransaction(); }
}

class FakeOpenRequest {
  constructor() {
    this.result          = new FakeIDBDatabase();
    this.onupgradeneeded = null;
    this.onsuccess       = null;
    this.onerror         = null;
    // Ensure DB schema exists, then fire onsuccess
    _ensureDB();
    Promise.resolve().then(() => {
      if (this.onsuccess) this.onsuccess({ target: this });
    });
  }
}

// ── Drop-in global shim ───────────────────────────────────────────────────

export const indexedDBShim = {
  open(_name, _version) {
    return new FakeOpenRequest();
  },
};
