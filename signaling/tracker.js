/**
 * tracker.js — Self-hosted WebTorrent tracker for EchoForge private fog networks.
 *
 * Drop-in replacement for wss://tracker.openwebtorrent.com when you need:
 *   - Zero external dependencies for private/air-gapped deployments
 *   - Full control over which info-hashes (rooms) are allowed
 *   - Audit log of peer join/leave events
 *
 * Usage:
 *   npm install && node tracker.js
 *   TRACKER_PORT=8888 node tracker.js
 *
 * In mesh.js init, pass relay_url:
 *   {type:"init", room_id:"my-room", relay_url:"ws://YOUR_IP:8888"}
 *
 * Tracker URL format for Trystero:
 *   ws://localhost:8888   (LAN)
 *   wss://tracker.yourdomain.com  (production, needs TLS termination)
 */

import { Server } from "bittorrent-tracker";

const PORT         = parseInt(process.env.TRACKER_PORT  ?? "8888");
const TRUST_PROXY  = !!process.env.TRACKER_TRUST_PROXY;
const ALLOW_ALL    = process.env.TRACKER_ALLOW_ALL !== "false";  // default: open

// Optional allowlist: comma-separated info-hash prefixes (first 8 hex chars)
// e.g. TRACKER_ALLOW_HASHES=a1b2c3d4,e5f6g7h8
const ALLOWED_HASHES = process.env.TRACKER_ALLOW_HASHES
  ? new Set(process.env.TRACKER_ALLOW_HASHES.split(",").map(h => h.trim().toLowerCase()))
  : null;

const server = new Server({
  ws:         true,
  http:       false,
  interval:   60_000,   // announce interval hint to clients (ms)
  trustProxy: TRUST_PROXY,

  filter(infoHash, _params, cb) {
    if (ALLOW_ALL || !ALLOWED_HASHES) return cb(null);
    if (ALLOWED_HASHES.has(infoHash.slice(0, 8))) return cb(null);
    cb(new Error("info-hash not on allowlist"));
  },
});

let _peerCount = 0;

server.on("error",   (err) => console.error("[tracker] error:", err.message));
server.on("warning", (msg) => console.warn("[tracker] warning:", msg));

server.on("update", (e) => {
  if (!e?.infoHash) return;  // skip connection-level pings with no torrent data
  const room = e.infoHash.slice(0, 8);
  console.log(`[tracker] update  peer=${e.addr} room=${room} want=${e.numwant}`);
});

server.on("complete", ({ addr, infoHash }) => {
  _peerCount++;
  const room = infoHash?.slice(0, 8) ?? "unknown";
  console.log(`[tracker] join    peer=${addr} room=${room} total=${_peerCount}`);
});

server.on("stop", ({ addr, infoHash }) => {
  _peerCount = Math.max(0, _peerCount - 1);
  const room = infoHash?.slice(0, 8) ?? "unknown";
  console.log(`[tracker] leave   peer=${addr} room=${room} total=${_peerCount}`);
});

server.listen(PORT, () => {
  console.log(`\n✓ EchoForge tracker  ws://0.0.0.0:${PORT}`);
  console.log(`  Private deployment — use in mesh init:`);
  console.log(`  {type:"init", room_id:"my-room", relay_url:"ws://YOUR_LAN_IP:${PORT}"}`);
  console.log(`  env: TRACKER_PORT  TRACKER_ALLOW_ALL  TRACKER_ALLOW_HASHES  TRACKER_TRUST_PROXY\n`);
});

// Graceful shutdown
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT",  () => server.close(() => process.exit(0)));
