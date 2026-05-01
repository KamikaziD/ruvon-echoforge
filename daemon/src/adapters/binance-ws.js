/**
 * binance-ws.js — JS Binance WebSocket adapter for the daemon subprocess
 *
 * Connects to the Binance public market data stream (no auth required).
 * Parses Binance native trade stream format and emits exchange-tagged ticks
 * to the provided callback so correlation_worker can compute cross-exchange
 * lead/lag relative to VALR.
 *
 * Does NOT maintain an orderbook — Binance is price-discovery monitoring only;
 * execution remains on VALR exclusively. Only the trade stream is subscribed.
 *
 * Default: Binance public stream. Override via ECHOFORGE_BINANCE_URL env var.
 * Note: testnet.binance.vision requires an API key — don't use it for market data.
 */

"use strict";

import WebSocket from "ws";

const BINANCE_DEFAULT = "wss://stream.binance.com:9443/ws/btcusdt@trade";

export class BinanceWebSocketAdapter {
  /**
   * @param {string|null} wsUrl  — Binance WS URL (or null to use ECHOFORGE_BINANCE_URL / default)
   * @param {(msg: object) => void} onMessage  — called for each parsed trade tick
   */
  constructor(wsUrl, onMessage) {
    this._url     = wsUrl || process.env.ECHOFORGE_BINANCE_URL || BINANCE_DEFAULT;
    this._onMsg   = onMessage;
    this._ws      = null;
    this._backoff = 2000;
    this._stopped = false;
  }

  start() { this._connect(); }

  stop() {
    this._stopped = true;
    if (this._ws) { this._ws.terminate(); this._ws = null; }
  }

  _connect() {
    if (this._stopped) return;
    console.info(`[binance-ws] Connecting to ${this._url}`);
    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.on("open", () => {
      console.info("[binance-ws] Connected");
      this._backoff = 2000;
    });

    ws.on("message", (raw) => {
      try {
        const d = JSON.parse(raw.toString());
        if (d.e !== "trade") return;

        const price = parseFloat(d.p);
        const qty   = parseFloat(d.q);
        if (!(price > 0)) return;

        this._onMsg({
          type:      "trade",
          symbol:    (d.s || "BTCUSDT").replace("/", ""),
          exchange:  "BINANCE",
          price,
          quantity:  qty,
          // d.m=true → buyer is market-maker → sell-side aggressor took liquidity
          side:      d.m ? "sell" : "buy",
          // d.T is Binance trade time in ms — use it directly for lag measurement
          timestamp: d.T || Date.now(),
        });
      } catch (_) {}
    });

    ws.on("close", () => {
      if (this._stopped) return;
      console.warn(`[binance-ws] Disconnected — reconnecting in ${this._backoff}ms`);
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, 60_000);
    });

    ws.on("error", (err) => {
      console.error("[binance-ws] Error:", err.message);
    });
  }
}
