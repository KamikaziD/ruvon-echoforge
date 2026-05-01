/**
 * valr-ws.js — JS VALR WebSocket adapter for the daemon subprocess
 *
 * Mirrors adapters/valr.py in JS. Connects to VALR real API or mock server.
 * Subscribes to NEW_TRADE + AGGREGATED_ORDERBOOK_UPDATE and routes them to
 * orderbook_worker via the provided postMessage callback.
 *
 * Reconnects on drop with exponential backoff (1s → 30s).
 */

"use strict";

import WebSocket from "ws";

const SUBSCRIBE_MSG = JSON.stringify({
  type: "SUBSCRIBE",
  subscriptions: [
    { event: "NEW_TRADE",                 pair: ["BTCUSDT"] },
    { event: "AGGREGATED_ORDERBOOK_UPDATE", pair: ["BTCUSDT"] },
  ],
});

export class VALRWebSocketAdapter {
  /**
   * @param {string} wsUrl - e.g. "wss://api.valr.com/v1/ws" or "ws://localhost:8766/v1/ws"
   * @param {(msg: object) => void} onMessage - receives parsed WS messages, routed to workers
   */
  constructor(wsUrl, onMessage) {
    this._url      = wsUrl;
    this._onMsg    = onMessage;
    this._ws       = null;
    this._backoff  = 1000;  // ms
    this._stopped  = false;
  }

  start() {
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
  }

  _connect() {
    if (this._stopped) return;

    console.info(`[valr-ws] Connecting to ${this._url}`);
    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.on("open", () => {
      console.info("[valr-ws] Connected");
      ws.send(SUBSCRIBE_MSG);
      this._backoff = 1000;  // reset on successful connection
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._route(msg);
      } catch (_) {}
    });

    ws.on("close", () => {
      if (this._stopped) return;
      console.warn(`[valr-ws] Disconnected — reconnecting in ${this._backoff}ms`);
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, 30_000);
    });

    ws.on("error", (err) => {
      console.error("[valr-ws] Error:", err.message);
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
