/**
 * execution_entry.js — worker_threads wrapper for execution_worker.js
 *
 * Each Bun worker_thread has an isolated globalThis, so the parent's
 * `globalThis.indexedDB = shim` assignment is invisible here.
 * This wrapper injects the shim before the real worker script loads.
 */

"use strict";

import { indexedDBShim, setIPCSend } from "../shims/indexed-db.js";
import { parentPort }                from "worker_threads";
import path                          from "path";
import { fileURLToPath }             from "url";

// Route IDB write-through to parent so runner.js can forward order_intents to IPC.
setIPCSend((msg) => parentPort?.postMessage(msg));

// Inject shim into this worker thread's global scope.
globalThis.indexedDB = indexedDBShim;

// Load the real execution worker. Use an absolute file:// URL so Bun resolves
// the worker relative to the browser/ directory, not daemon/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../../browser/workers/execution_worker.js");
await import(workerPath);
