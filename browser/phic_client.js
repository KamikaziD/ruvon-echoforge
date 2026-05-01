/**
 * phic_client.js — PHIC governance config fetch and live subscribe.
 *
 * Polls GET /api/v1/phic/config on startup, then subscribes via WebSocket
 * /api/v1/metrics for push updates. Applies new config to all workers.
 */

"use strict";

export class PHICClient {
  constructor(bridgeUrl, onConfig) {
    this._url    = bridgeUrl.replace(/\/$/, "");
    this._onConfig = onConfig;  // callback(config)
    this._ws     = null;
    this._config = null;
  }

  async start() {
    // Initial fetch
    try {
      const resp = await fetch(`${this._url}/api/v1/phic/config`);
      if (resp.ok) {
        this._config = await resp.json();
        this._onConfig(this._config);
      }
    } catch (e) {
      console.warn("[PHIC] Config fetch failed:", e.message);
    }

    // WebSocket subscribe for live updates
    this._connectWS();
  }

  async push(config) {
    try {
      const resp = await fetch(`${this._url}/api/v1/phic/config`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(config),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error("[PHIC] Config push failed:", e.message);
      throw e;
    }
  }

  async freeze() {
    return fetch(`${this._url}/api/v1/phic/freeze`, { method: "POST" });
  }

  get config() { return this._config; }

  _connectWS() {
    const wsUrl = this._url.replace(/^http/, "ws") + "/api/v1/metrics";
    this._ws = new WebSocket(wsUrl);

    this._ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "phic_update") {
          this._config = msg.config;
          this._onConfig(msg.config);
        }
      } catch { /* ignore */ }
    };

    this._ws.onclose = () => {
      setTimeout(() => this._connectWS(), 3000);
    };

    this._ws.onerror = () => {
      this._ws.close();
    };
  }

  stop() {
    if (this._ws) this._ws.close();
  }
}
