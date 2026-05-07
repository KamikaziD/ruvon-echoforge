/**
 * mesh.js — WebRTC P2P gossip layer for SharedEcho aliveness sync.
 *
 * Runs on the MAIN THREAD (not a Worker) so RTCPeerConnection is available
 * under COOP/COEP cross-origin isolation. Trystero needs RTCPeerConnection
 * in the global scope, which is only guaranteed on the main thread in Chrome.
 *
 * Transport: Trystero torrent strategy (openwebtorrent.com tracker only).
 *   - No signaling server required — tracker handles SDP/ICE exchange
 *   - Falls back to BroadcastChannel for same-origin multi-tab
 *
 * API (imported as ES module by index.html):
 *   init(config, onMessage)  — start mesh; config = {node_id, room_id, relay_url}
 *   handle(msg)              — dispatch an inbound message (replaces postMessage in)
 *
 * Callbacks OUT (via onMessage registered in init):
 *   {type:"peer_echo",       pattern_id, net_aliveness, regime_tag, decay_rate, node_id}
 *   {type:"peer_sentinel",   sentinel_type, action, severity, node_id}
 *   {type:"mesh_status",     peers: number, connected: bool}
 *   {type:"sovereign_update",sovereign_node_id, is_sovereign, s_ex, score_table}
 *   {type:"routed_intent",   intent}
 *   {type:"regime_commit",   regime, vote_id, votes, quorum}
 */

"use strict";

// ── S(Ex) weights ──────────────────────────────────────────────────────────
// S(Ex) = 0.50·L_factor + 0.25·U + 0.15·C + 0.10·P
const W_L = 0.50, W_U = 0.25, W_C = 0.15, W_P = 0.10;
const LATENCY_SCALE = 200;   // ms → L_factor=0

// ── Anti-flap ─────────────────────────────────────────────────────────────
const HYSTERESIS_MARGIN            = 0.15;
const ELECTION_COOLDOWN_MS         = 30_000;
const SCORE_EWMA_ALPHA             = 0.25;
const SOVEREIGN_ELECTION_INTERVAL_MS = 5_000;
const SOVEREIGN_STALE_MS             = 15_000;

function _scoreEx(latencyMs, successRate, connected, isRateLimited) {
  const L = Math.max(0, 1 - latencyMs / LATENCY_SCALE);
  const U = Math.max(0, Math.min(1, successRate));
  const C = connected ? 1.0 : 0.0;
  const P = isRateLimited ? 0.0 : 1.0;
  return +(W_L * L + W_U * U + W_C * C + W_P * P).toFixed(4);
}

// ── Dedup ──────────────────────────────────────────────────────────────────
const DEDUP_MAX     = 200;
const GOSSIP_TTL_MS = 30_000;
const _dedup        = [];

function _isDuplicate(key) {
  if (_dedup.includes(key)) return true;
  _dedup.push(key);
  if (_dedup.length > DEDUP_MAX) _dedup.shift();
  return false;
}

// ── Regime quorum ──────────────────────────────────────────────────────────
// Flood-style protocol: proposer broadcasts vote_id; peers echo their own vote;
// every node independently declares commit when it has N/2+1 unique voter IDs.
const QUORUM_TIMEOUT_MS  = 10_000;
const REGIME_DWELL_MS    = 4_000;   // minimum ms between regime commits — prevents quorum flap
const _regimeVotes       = new Map();  // vote_id → { regime, voters: Set<node_id> }
const _committedVoteIds  = new Set();  // prevent re-processing after quorum commit

// ── State ──────────────────────────────────────────────────────────────────
let _currentRegime      = "LowVol";
let _lastRegimeCommitAt = 0;
let _nodeId    = null;

// ── Cross-tab exposure registry ────────────────────────────────────────────
// Each tab broadcasts its live exposure_pct every REGISTRY_HB_MS via BroadcastChannel.
// The registry is BroadcastChannel-only (same origin) — WebRTC not needed.
const REGISTRY_HB_MS  = 5_000;
const REGISTRY_TTL_MS = 15_000;  // stale tab entries expire after 15s
const _tabRegistry      = new Map();  // tab_id → {exposure_pct, last_direction, regime, ts}
let   _localExposure    = 0;          // updated by index.html via handle({type:"exposure_update"})
let   _lastIntentDirection = null;    // "buy" | "sell" | null — updated on each routed intent
let   _registryBcRef    = null;       // BroadcastChannel reference set in _initBroadcastChannel

function _registryBroadcast() {
  if (!_registryBcRef || !_nodeId) return;
  _registryBcRef.postMessage({
    type:            "registry",
    tab_id:          _nodeId,
    exposure_pct:    _localExposure,
    last_direction:  _lastIntentDirection,
    regime:          _currentRegime,
    ts:              Date.now(),
  });
}

function _computeMeshExposure() {
  const now    = Date.now();
  const cutoff = now - REGISTRY_TTL_MS;
  let sum = _localExposure, count = 1;
  let buyCount = _lastIntentDirection === "buy" ? 1 : 0;
  for (const [id, entry] of _tabRegistry) {
    if (entry.ts < cutoff) { _tabRegistry.delete(id); continue; }
    sum += entry.exposure_pct;
    if (entry.last_direction === "buy") buyCount++;
    count++;
  }
  const meshExposure    = sum / count;
  const meshBuyPressure = count > 0 ? buyCount / count : 0;
  if (_onMessage) {
    _onMessage({ type: "mesh_exposure_update", meshExposure: +meshExposure.toFixed(4), tabCount: count });
    _onMessage({ type: "mesh_heat_update", mesh_buy_pressure: +meshBuyPressure.toFixed(4), tab_count: count });
  }
}
// ── Daemon sovereignty ─────────────────────────────────────────────────────
// When the runner.js daemon is reachable its /api/v1/health responds 200.
// All tabs immediately hand sovereignty to "daemon" and route intents via HTTP.
// If the daemon goes offline, tabs fall back to the tab election within one cycle.
let _bridgeUrl     = null;
let _daemonAlive   = false;
let _daemonCheckId = null;
const DAEMON_CHECK_MS   = 5_000;
const DAEMON_TIMEOUT_MS = 2_000;

async function _checkDaemon() {
  if (!_bridgeUrl) return;
  let alive = false;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), DAEMON_TIMEOUT_MS);
    const resp = await fetch(`${_bridgeUrl}/api/v1/health`, { signal: ctrl.signal });
    clearTimeout(tid);
    alive = resp.ok;
  } catch (_) {}

  if (alive && !_daemonAlive) {
    _daemonAlive = true;
    console.info("[sovereign] Daemon online — handing sovereignty to daemon");
    _emitDaemonSovereign();
  } else if (!alive && _daemonAlive) {
    _daemonAlive = false;
    console.info("[sovereign] Daemon offline — reverting to tab election");
    _forceReelect("daemon_offline");
  }
}

function _emitDaemonSovereign() {
  if (_onMessage) _onMessage({
    type:              "sovereign_update",
    sovereign_node_id: "daemon",
    is_sovereign:      false,
    s_ex:              1.0,
    score_table:       { daemon: 1.0, [_nodeId]: _ownScoreSmoothed },
    reason:            "daemon",
  });
}

let _roomId    = null;
let _relayUrl  = null;   // custom tracker URL for private deployments
let _onMessage = null;   // callback registered by init() — replaces self.postMessage

// Peer set (Trystero manages DataChannels; we track IDs for counting)
const _peerIds = new Set();

// Trystero room + action senders (null until init)
let _sendGossip   = null;
let _sendIntent   = null;
let _sendVote     = null;
let _trysteroRoom = null;  // stored for room.leave() on re-init

// BroadcastChannel + interval handles for teardown on re-init
let _bcChannel      = null;
let _bcHeartbeatId  = null;
let _registryHbId   = null;

// S(Ex) sovereign state
const _peerScores     = new Map();
let _ownScore         = { exchange_latency_ms: 10, success_rate: 1.0, is_rate_limited: false };
let _ownScoreSmoothed = _scoreEx(10, 1.0, true, false);
let _sovereignId        = null;
let _lastElectionAt     = 0;
let _electionIntervalId = null;
let _electionHeld       = false;  // true after first _applyElection; guards hysteresis on bootstrap

// ── Public API (called by index.html instead of Worker postMessage) ────────

/**
 * Start the mesh transport.
 * @param {object} config   - {node_id, room_id, relay_url}
 * @param {function} onMessage - callback for outbound messages to caller
 */
export async function init(config, onMessage) {
  // ── Teardown previous session ─────────────────────────────────────────────
  if (_electionIntervalId) { clearInterval(_electionIntervalId); _electionIntervalId = null; }
  if (_daemonCheckId)      { clearInterval(_daemonCheckId);      _daemonCheckId = null; }
  if (_bcHeartbeatId)      { clearInterval(_bcHeartbeatId);      _bcHeartbeatId = null; }
  if (_registryHbId)       { clearInterval(_registryHbId);       _registryHbId = null; }
  if (_bcChannel)          { _bcChannel.onmessage = null; _bcChannel.close(); _bcChannel = null; }
  if (_trysteroRoom)       { try { _trysteroRoom.leave(); } catch (_) {} _trysteroRoom = null; }
  _peerIds.clear();
  _electionHeld = false;
  _sovereignId  = null;
  _daemonAlive  = false;
  // ─────────────────────────────────────────────────────────────────────────
  _nodeId    = config.node_id   || ("node-" + Math.random().toString(36).slice(2, 8));
  _roomId    = config.room_id   || "echoforge-syndicate";
  _relayUrl  = config.relay_url || null;
  _bridgeUrl = config.bridge_url || null;
  _onMessage = onMessage;
  await _initTransport(_roomId);

  // Start daemon health probe — if daemon is reachable it becomes sovereign immediately
  if (_bridgeUrl) {
    _checkDaemon();  // immediate first check
    _daemonCheckId = setInterval(_checkDaemon, DAEMON_CHECK_MS);
  }

  // Discovery window: wait one interval for peer gossip before holding the first election.
  // Without this, every tab immediately declares itself sovereign (dual-sovereignty bug).
  // After the delay, _electSovereign fires and defers to any incumbent with a higher score.
  setTimeout(() => {
    _electSovereign();
    _electionIntervalId = setInterval(_electSovereign, SOVEREIGN_ELECTION_INTERVAL_MS);
  }, SOVEREIGN_ELECTION_INTERVAL_MS);

  // Emit an initial score-only snapshot so the S(Ex) display populates immediately.
  // is_sovereign=false here — sovereignty is decided by _electSovereign at T+5s.
  // Both tabs starting simultaneously must NOT claim sovereignty before the election.
  if (_onMessage) _onMessage({
    type:              "sovereign_update",
    sovereign_node_id: "—",
    is_sovereign:      false,
    s_ex:              _ownScoreSmoothed,
    score_table:       { [_nodeId]: _ownScoreSmoothed },
    reason:            "init",
  });
}

/**
 * Dispatch an inbound message (replaces worker.postMessage from the caller side).
 * @param {object} msg
 */
export function handle(msg) {
  switch (msg.type) {
    case "gossip_out":
      _broadcast({ type: "echo", ...msg, node_id: _nodeId });
      break;

    case "sentinel_out":
      _broadcast({ type: "sentinel_alert", ...msg, node_id: _nodeId });
      break;

    case "own_score":
      _ownScore = { ...msg };
      {
        const rawOwn = _scoreEx(msg.exchange_latency_ms, msg.success_rate, true, msg.is_rate_limited);
        _ownScoreSmoothed = +(_ownScoreSmoothed * (1 - SCORE_EWMA_ALPHA) + rawOwn * SCORE_EWMA_ALPHA).toFixed(4);
      }
      break;

    case "intent_route":
      _routeIntent(msg.intent);
      break;

    case "vote_proposal":
      _startRegimeVote(msg.regime);
      break;

    case "regime_change":
      _currentRegime = msg.regime_tag || _currentRegime;
      break;

    case "exposure_update":
      // index.html pushes the local tab's current exposure so mesh can broadcast it
      _localExposure = msg.exposure_pct ?? 0;
      break;

    default:
      break;
  }
}

// ── Transport bootstrap ────────────────────────────────────────────────────

async function _initTransport(roomId) {
  // BroadcastChannel always starts immediately — covers same-machine tabs regardless
  // of whether WebRTC/Trystero succeeds.
  _initBroadcastChannel(roomId);

  try {
    const { joinRoom } = await import("./trystero-torrent.js");
    _initTrystero(joinRoom, roomId);
  } catch (e) {
    console.warn("[mesh] Trystero unavailable, BroadcastChannel only:", e.message);
  }
}

// ── Trystero (primary transport) ───────────────────────────────────────────

function _initTrystero(joinRoom, roomId) {
  const relayUrls = _relayUrl
    ? [_relayUrl]
    : ["wss://tracker.openwebtorrent.com"];

  const room = joinRoom(
    { appId: "ruvon-echoforge", relayUrls },
    roomId,
  );
  _trysteroRoom = room;  // stored for room.leave() on re-init

  console.info("[mesh] Trystero relay:", relayUrls[0]);

  const [sendGossip, onGossip] = room.makeAction("gossip");
  const [sendIntent, onIntent] = room.makeAction("intent");
  const [sendVote,   onVote]   = room.makeAction("vote");

  // Layer Trystero on top of BroadcastChannel — both send in parallel
  const _prevGossip = _sendGossip;
  const _prevVote   = _sendVote;
  _sendGossip = (payload) => { try { sendGossip(payload); } catch(_){} _prevGossip?.(payload); };
  _sendIntent = sendIntent;
  _sendVote   = (payload) => { try { sendVote(payload); } catch(_){} _prevVote?.(payload); };

  // Inbound gossip from any peer
  onGossip((data, peerId) => _onData(data, peerId));

  // Inbound intent (forwarded to sovereign — which is us)
  onIntent((data, _peerId) => {
    if (data?.type === "routed_intent") {
      if (_onMessage) _onMessage({ type: "routed_intent", intent: data.intent });
    }
  });

  // Inbound regime votes from peers
  onVote((data, _peerId) => {
    if (data?.type === "regime_vote") _handleRegimeVote(data);
  });

  room.onPeerJoin((peerId) => {
    _peerIds.add(peerId);
    _reportStatus();
    _sendGossip({ type: "announce", node_id: _nodeId });
    // Push full state snapshot to the joining peer
    if (_onMessage) _onMessage({ type: "peer_joined", node_id: peerId });
  });

  room.onPeerLeave((peerId) => {
    _peerIds.delete(peerId);
    // If the sovereign left, force immediate re-election
    const peerScore = _peerScores.get(peerId);
    if (peerScore) _peerScores.delete(peerId);
    if (_sovereignId === peerId) {
      console.info(`[sovereign] ${peerId.slice(0, 8)} left — forcing re-election`);
      _forceReelect("peer_left");
    }
    _reportStatus();
  });

  _reportStatus();
  console.info("[mesh] Trystero torrent transport active — room:", roomId);
}

// ── BroadcastChannel (same device, always active) ─────────────────────────

function _initBroadcastChannel(roomId) {
  const ch         = new BroadcastChannel(roomId);
  _bcChannel       = ch;          // tracked for teardown on re-init
  _registryBcRef   = ch;          // shared ref so _registryBroadcast can reach it
  const _bcSeen    = new Map();   // node_id → last_seen ms
  const BC_TTL_MS  = 20_000;
  const BC_HB_MS   = 6_000;

  function _bcRefresh(nodeId) {
    const isNew = !_bcSeen.has(nodeId);
    _bcSeen.set(nodeId, Date.now());
    if (isNew) {
      _peerIds.add(nodeId);
      _reportStatus();
      // Reply immediately so the new peer learns we exist (one-shot, no ping-pong)
      ch.postMessage({ type: "announce", node_id: _nodeId, timestamp: Date.now() });
      // Tell the caller a new peer appeared so it can push a state snapshot
      if (_onMessage) _onMessage({ type: "peer_joined", node_id: nodeId });
    }
  }

  function _bcPrune() {
    const cutoff = Date.now() - BC_TTL_MS;
    let changed = false;
    for (const [id, ts] of _bcSeen) {
      if (ts < cutoff) { _bcSeen.delete(id); _peerIds.delete(id); changed = true; }
    }
    if (changed) _reportStatus();
  }

  ch.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg?.node_id || msg.node_id === _nodeId) return;
    _bcRefresh(msg.node_id);
    _onData(msg, msg.node_id);
  };

  _sendGossip = (payload) => { payload.node_id = _nodeId; ch.postMessage(payload); };
  _sendVote   = (payload) => { ch.postMessage({ ...payload, node_id: _nodeId }); };
  _sendIntent = null;

  // Announce presence immediately and keep a heartbeat so peers see us join/leave
  _bcHeartbeatId = setInterval(() => {
    ch.postMessage({ type: "announce", node_id: _nodeId, timestamp: Date.now() });
    _bcPrune();
  }, BC_HB_MS);
  ch.postMessage({ type: "announce", node_id: _nodeId, timestamp: Date.now() });

  // Registry heartbeat — broadcast local exposure every 5s and recompute mesh aggregate
  _registryHbId = setInterval(() => {
    _registryBroadcast();
    _computeMeshExposure();
  }, REGISTRY_HB_MS);

  _reportStatus();
  console.info("[mesh] BroadcastChannel fallback active — channel:", roomId);
}

// ── Broadcast (Trystero full-mesh or BroadcastChannel) ────────────────────

function _broadcast(payload) {
  if (_sendGossip) {
    try { _sendGossip(payload); } catch (e) { console.warn("[mesh] broadcast error:", e.message); }
  }
}

// ── Incoming message handler ───────────────────────────────────────────────

function _onData(msg, peerId) {
  if (!msg || typeof msg !== "object") return;

  // Ignore own reflections (BroadcastChannel can echo back)
  if (msg.node_id === _nodeId) return;

  // TTL guard
  if (msg.timestamp && Date.now() - msg.timestamp > GOSSIP_TTL_MS) return;

  // Dedup — use vote_id for regime votes so repeated re-broadcasts are correctly keyed
  const dedupKey = `${msg.node_id}:${msg.pattern_id || msg.sentinel_type || msg.vote_id || msg.type}:${msg.timestamp || ""}`;
  if (_isDuplicate(dedupKey)) return;

  switch (msg.type) {
    case "echo":
      _handleEcho(msg);
      break;

    case "sentinel_alert":
      if (_onMessage) _onMessage({
        type:          "peer_sentinel",
        sentinel_type: msg.sentinel_type,
        action:        msg.action,
        severity:      msg.severity,
        node_id:       msg.node_id,
        timestamp:     msg.timestamp,
      });
      break;

    case "regime_vote":
      _handleRegimeVote(msg);
      break;

    case "announce":
      // Heartbeat handles ongoing presence; just refresh peer timestamp
      break;

    case "registry":
      // Cross-tab exposure registry — update peer entry, recompute mesh aggregate
      if (msg.tab_id && msg.tab_id !== _nodeId) {
        _tabRegistry.set(msg.tab_id, {
          exposure_pct:   msg.exposure_pct   ?? 0,
          last_direction: msg.last_direction ?? null,
          regime:         msg.regime         ?? "LowVol",
          ts:             msg.ts             ?? Date.now(),
        });
        _computeMeshExposure();
      }
      break;

    case "routed_intent":
      // Non-sovereign peer forwarded us an intent
      if (_onMessage) _onMessage({ type: "routed_intent", intent: msg.intent });
      break;
  }
}

function _handleEcho(msg) {
  // Update peer S(Ex) score table with EWMA smoothing
  if (msg.node_id && msg.exchange_latency_ms != null) {
    const s_ex_raw = _scoreEx(
      msg.exchange_latency_ms,
      msg.execution_success_rate ?? 1.0,
      true,
      msg.is_rate_limited ?? false,
    );
    const prev = _peerScores.get(msg.node_id);
    const s_ex_smoothed = prev
      ? +(prev.s_ex_smoothed * (1 - SCORE_EWMA_ALPHA) + s_ex_raw * SCORE_EWMA_ALPHA).toFixed(4)
      : s_ex_raw;
    _peerScores.set(msg.node_id, {
      s_ex_raw,
      s_ex_smoothed,
      exchange_latency_ms: msg.exchange_latency_ms,
      success_rate:        msg.execution_success_rate ?? 1.0,
      is_rate_limited:     msg.is_rate_limited ?? false,
      last_seen:           Date.now(),
    });
  }

  if (_onMessage) _onMessage({
    type:          "peer_echo",
    pattern_id:    msg.pattern_id,
    net_aliveness: msg.net_aliveness,
    regime_tag:    msg.regime_tag,
    decay_rate:    msg.decay_rate,
    node_id:       msg.node_id,
    timestamp:     msg.timestamp,
  });
}

// ── Regime quorum consensus ────────────────────────────────────────────────
// Flood protocol: proposer + all peers broadcast their vote; every node independently
// checks quorum. First node to reach majority fires regime_commit to main thread.

function _startRegimeVote(regime) {
  const voteId = `${_nodeId}:${Date.now()}`;
  const entry  = { regime, voters: new Set([_nodeId]) };
  _regimeVotes.set(voteId, entry);

  // Broadcast own vote
  if (_sendVote) {
    try {
      _sendVote({ type: "regime_vote", regime, vote_id: voteId, voter_id: _nodeId });
    } catch (e) {
      console.warn("[regime] vote broadcast failed:", e.message);
    }
  }

  _checkRegimeQuorum(voteId);
  setTimeout(() => _regimeVotes.delete(voteId), QUORUM_TIMEOUT_MS);
}

function _handleRegimeVote(msg) {
  const { regime, vote_id, voter_id } = msg;
  if (!vote_id || !voter_id || !regime) return;
  if (_committedVoteIds.has(vote_id)) return;  // already committed — drop re-broadcasts

  let entry = _regimeVotes.get(vote_id);
  if (!entry) {
    // First time seeing this proposal — register and cast our own vote
    entry = { regime, voters: new Set([voter_id, _nodeId]) };
    _regimeVotes.set(vote_id, entry);
    // Re-broadcast so late-joiners also hear our vote
    if (_sendVote) {
      try {
        _sendVote({ type: "regime_vote", regime, vote_id, voter_id: _nodeId });
      } catch (_) {}
    }
    setTimeout(() => _regimeVotes.delete(vote_id), QUORUM_TIMEOUT_MS);
  } else {
    entry.voters.add(voter_id);
  }

  _checkRegimeQuorum(vote_id);
}

function _checkRegimeQuorum(voteId) {
  const entry = _regimeVotes.get(voteId);
  if (!entry) return;

  // Quorum = majority of all currently known nodes (peers + self)
  const totalNodes = _peerIds.size + 1;
  const quorum     = Math.ceil(totalNodes / 2);

  if (entry.voters.size >= quorum) {
    _regimeVotes.delete(voteId);
    // Suppress duplicate commits: don't re-commit the regime we're already in
    if (entry.regime === _currentRegime) return;
    // Anti-flap dwell: ignore rapid oscillations within 4s of last commit
    const now = Date.now();
    if (now - _lastRegimeCommitAt < REGIME_DWELL_MS) return;
    _lastRegimeCommitAt = now;
    _currentRegime = entry.regime;
    _committedVoteIds.add(voteId);
    setTimeout(() => _committedVoteIds.delete(voteId), QUORUM_TIMEOUT_MS * 3);
    console.info(
      `[regime] quorum: ${entry.regime} (${entry.voters.size}/${totalNodes}) — committing`,
    );
    if (_onMessage) _onMessage({
      type:     "regime_commit",
      regime:   entry.regime,
      vote_id:  voteId,
      votes:    entry.voters.size,
      quorum,
    });
  }
}

// ── Sovereign election (anti-flap: EWMA + cooldown + hysteresis) ───────────

function _electSovereign() {
  if (_daemonAlive) return;  // daemon is sovereign — skip tab election entirely
  const now = Date.now();
  const myScore = _ownScoreSmoothed;

  // Prune stale peer scores → force re-election if incumbent went stale
  for (const [id, rec] of _peerScores) {
    if (now - rec.last_seen > SOVEREIGN_STALE_MS) {
      _peerScores.delete(id);
      if (_sovereignId === id) {
        console.info(`[sovereign] ${id.slice(0, 8)} stale — forcing re-election`);
        _forceReelect("stale_peer");
        return;
      }
    }
  }

  const incumbentId    = _sovereignId ?? _nodeId;
  const incumbentScore = incumbentId === _nodeId
    ? myScore
    : (_peerScores.get(incumbentId)?.s_ex_smoothed ?? 0);

  let bestId = _nodeId, bestScore = myScore;
  for (const [id, rec] of _peerScores) {
    const s = rec.s_ex_smoothed;
    if (s > bestScore || (s === bestScore && id > bestId)) { bestScore = s; bestId = id; }
  }

  // Best candidate is already the incumbent — only act if bootstrap or peer left
  if (bestId === incumbentId) {
    if (!_electionHeld || _sovereignId !== null) {
      // Bootstrap (first election, no peers yet) OR peer left and we must re-confirm self
      _applyElection(_nodeId, myScore, myScore, _sovereignId !== null ? "no_peers" : "bootstrap");
    }
    return;
  }

  // Layer 2 — Cooldown
  if (now - _lastElectionAt < ELECTION_COOLDOWN_MS) {
    console.debug(
      `[sovereign] cooldown active (${Math.round((ELECTION_COOLDOWN_MS - (now - _lastElectionAt)) / 1000)}s left)` +
      ` — challenger ${bestId.slice(0, 8)} (${bestScore.toFixed(3)}) blocked`,
    );
    return;
  }

  // Layer 3 — Hysteresis (skipped on the bootstrap election so first election is always decisive)
  if (_electionHeld) {
    const margin = bestScore - incumbentScore;
    if (margin < HYSTERESIS_MARGIN) {
      console.debug(
        `[sovereign] hysteresis blocked: margin=${margin.toFixed(3)} < ${HYSTERESIS_MARGIN}` +
        ` (incumbent=${incumbentScore.toFixed(3)} challenger=${bestScore.toFixed(3)})`,
      );
      return;
    }
  }

  _applyElection(bestId, bestScore, myScore, "voluntary");
}

function _forceReelect(reason) {
  const myScore = _ownScoreSmoothed;
  let bestId = _nodeId, bestScore = myScore;
  for (const [id, rec] of _peerScores) {
    const s = rec.s_ex_smoothed;
    if (s > bestScore || (s === bestScore && id > bestId)) { bestScore = s; bestId = id; }
  }
  _applyElection(bestId, bestScore, myScore, reason);
}

function _applyElection(bestId, bestScore, myScore, reason) {
  _electionHeld   = true;
  _sovereignId    = bestId === _nodeId ? null : bestId;
  _lastElectionAt = Date.now();
  const isSovereign = _sovereignId === null;

  console.info(
    `[sovereign] elected=${bestId.slice(0, 8)} isSelf=${isSovereign}` +
    ` score=${bestScore.toFixed(3)} reason=${reason}`,
  );

  const scoreTable = { [_nodeId]: myScore };
  for (const [id, rec] of _peerScores) scoreTable[id] = rec.s_ex_smoothed;

  if (_onMessage) _onMessage({
    type:              "sovereign_update",
    sovereign_node_id: isSovereign ? _nodeId : _sovereignId,
    is_sovereign:      isSovereign,
    s_ex:              isSovereign ? myScore : bestScore,
    score_table:       scoreTable,
    reason,
  });
}

// ── Intent routing ─────────────────────────────────────────────────────────

function _routeIntent(intent) {
  // Track last intent direction for mesh heat coordination
  if (intent.direction) _lastIntentDirection = intent.direction;

  // Daemon sovereign path — POST to runner.js; fills come back via WS broadcastStream
  if (_daemonAlive && _bridgeUrl) {
    fetch(`${_bridgeUrl}/api/v1/intent`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...intent, node_id: _nodeId }),
    }).catch((err) => {
      console.warn("[mesh] daemon intent POST failed:", err.message);
      // Daemon went away mid-request — execute locally and let health probe detect the outage
      if (_onMessage) _onMessage({ type: "routed_intent", intent });
    });
    return;
  }

  if (!_sovereignId) {
    // We are sovereign — execute locally
    if (_onMessage) _onMessage({ type: "routed_intent", intent });
    return;
  }

  // Forward to sovereign tab via Trystero targeted send
  if (_sendIntent) {
    try {
      _sendIntent(
        { type: "routed_intent", intent, node_id: _nodeId },
        _sovereignId,
      );
      return;
    } catch (e) {
      console.warn("[mesh] intent route failed:", e.message);
    }
  }

  // Fallback — execute locally if targeted send unavailable or failed
  _sovereignId = null;
  if (_onMessage) _onMessage({ type: "routed_intent", intent });
}

// ── Status ─────────────────────────────────────────────────────────────────

function _reportStatus() {
  if (_onMessage) _onMessage({
    type:      "mesh_status",
    peers:     _peerIds.size,
    connected: _peerIds.size > 0,
  });
}
