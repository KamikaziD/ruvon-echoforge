/**
 * valr-ws.js — JS VALR WebSocket adapter for the daemon subprocess
 *
 * Mirrors adapters/valr.py in JS. Connects to VALR real API or mock server.
 * Subscribes to NEW_TRADE + AGGREGATED_ORDERBOOK_UPDATE and routes them to
 * orderbook_worker via the provided postMessage callback.
 *
 * Reconnects on drop with exponential backoff (1s → 30s).
 *
 * Resilience features:
 *   CONNECTING timeout  — kills stuck handshakes after 10s (VALR can hang TCP)
 *   PONG watchdog       — detects zombie connections (open TCP but VALR stopped)
 *   Backoff             — 1s → 2s → 4s → ... → 30s cap, resets on successful open
 */

"use strict";

import WebSocket from "ws";

const SUBSCRIBE_MSG = JSON.stringify({
  type: "SUBSCRIBE",
  subscriptions: [
    { event: "NEW_TRADE",                  pairs: ["BTCUSDT"] },
    { event: "AGGREGATED_ORDERBOOK_UPDATE", pairs: ["BTCUSDT"] },
  ],
});

const PING_MSG           = '{"type":"PING"}';
const PING_INTERVAL_MS   = 15_000;  // VALR closes after ~30s without PING
const CONNECT_TIMEOUT_MS = 10_000;  // kill stuck CONNECTING after this
const PONG_TIMEOUT_MS    = 35_000;  // if no PONG in this window → zombie → reconnect

export class VALRWebSocketAdapter {
  /**
   * @param {string} wsUrl - e.g. "wss://api.valr.com/v1/ws" or "ws://localhost:8766/v1/ws"
   * @param {(msg: object) => void} onMessage - receives parsed WS messages, routed to workers
   */
  constructor(wsUrl, onMessage) {
    this._url           = wsUrl;
    this._onMsg         = onMessage;
    this._ws            = null;
    this._backoff       = 1000;
    this._stopped       = false;
    this._pingTimer     = null;
    this._connectTimer  = null;  // kills hung CONNECTING sockets
    this._pongWatchdog  = null;  // detects zombie open connections
    this._lastPong      = 0;
  }

  start() {
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
  }

  _clearTimers() {
    clearTimeout(this._connectTimer);
    clearInterval(this._pingTimer);
    clearInterval(this._pongWatchdog);
    this._connectTimer = null;
    this._pingTimer    = null;
    this._pongWatchdog = null;
  }

  _connect() {
    if (this._stopped) return;

    console.info(`[valr-ws] Connecting to ${this._url}`);
    const ws = new WebSocket(this._url);
    this._ws = ws;

    // Kill the socket if it stays stuck in CONNECTING (VALR can hang TCP handshake).
    this._connectTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        console.warn(`[valr-ws] Connection timeout after ${CONNECT_TIMEOUT_MS}ms — retrying`);
        ws.terminate();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      console.info("[valr-ws] Connected");
      ws.send(SUBSCRIBE_MSG);
      this._backoff  = 1000;
      this._lastPong = Date.now();

      // Application-level PING — VALR closes after ~30s without one.
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(PING_MSG);
      }, PING_INTERVAL_MS);

      // PONG watchdog — detect zombie connections where TCP looks open but
      // VALR has stopped responding. Fires every 10s; triggers on first check
      // after PONG_TIMEOUT_MS silence.
      clearInterval(this._pongWatchdog);
      this._pongWatchdog = setInterval(() => {
        if (Date.now() - this._lastPong > PONG_TIMEOUT_MS) {
          console.warn("[valr-ws] PONG watchdog expired — zombie connection, reconnecting");
          ws.terminate();  // triggers onclose → reconnect
        }
      }, 10_000);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "PONG") { this._lastPong = Date.now(); return; }
        this._route(msg);
      } catch (_) {}
    });

    ws.on("close", (code, reason) => {
      this._clearTimers();
      if (this._stopped) return;
      const why = reason?.toString() || code || "unknown";
      console.warn(`[valr-ws] Disconnected (${why}) — reconnecting in ${this._backoff}ms`);
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, 30_000);
    });

    ws.on("error", (err) => {
      console.error("[valr-ws] Error:", err.message);
      // onerror always fires before onclose; reconnect handled there.
    });
  }

  _route(msg) {
    const data = msg.data || {};
    const pair = data.currencyPair || "BTCUSDT";
    const symbol = pair.replace("/", "");  // normalise to "BTCUSDT"

    if (msg.type === "NEW_TRADE") {
      this._onMsg({
        type:      "trade",
        symbol,
        exchange:  "VALR",
        price:     parseFloat(data.price)    || 0,
        quantity:  parseFloat(data.quantity) || 0,
        side:      (data.takerSide || "buy").toLowerCase(),
        timestamp: data.tradedAt ? new Date(data.tradedAt).getTime() : Date.now(),
      });
    } else if (msg.type === "AGGREGATED_ORDERBOOK_UPDATE") {
      const bids = (data.Bids || []).map(b => [parseFloat(b.price), parseFloat(b.quantity)]);
      const asks = (data.Asks || []).map(a => [parseFloat(a.price), parseFloat(a.quantity)]);
      this._onMsg({
        type:      "l2_snapshot",
        symbol,
        exchange:  "VALR",
        bids,
        asks,
        timestamp: data.LastChange ? new Date(data.LastChange).getTime() : Date.now(),
      });
    }
  }
}
