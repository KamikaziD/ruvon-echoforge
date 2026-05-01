/**
 * inference_worker.js — Web Worker 5
 *
 * Loads the ONNX signal model and runs inference on every market tick.
 * Supports both 8-feature (market-only) and 11-feature (+ position context) models.
 * Model width is probed once at load time — no metadata API required.
 *
 * Input features (Float32):
 *   [momentum, z_score, vwap_dev, imbalance, vol_ratio,
 *    spread_norm, ema_fast_dev, ema_slow_dev,
 *    cost_basis_dev*, unrealized_pnl_norm*, pos_size_norm*]  (* only in 11-feature model)
 *
 * Messages IN:
 *   {type:"init"}
 *   {type:"reload_model", model_bytes|buffer}
 *   {type:"infer", features:Float32Array, pattern_id, regime_tag, fee, slippage}
 *
 * Messages OUT:
 *   {type:"inference_ready", retrained?}
 *   {type:"inference_result", pattern_id, regime_tag, gross_delta, p_up, fee, slippage}
 *   {type:"inference_error",  error}
 */

"use strict";

import ort from "../ort.js";

const _isNodeRuntime = typeof process !== "undefined" && !!process.versions?.node;
const _execProviders = _isNodeRuntime ? ["cpu"] : ["wasm"];

if (!_isNodeRuntime && ort.env?.wasm) {
  const _distUrl = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url).href;
  ort.env.wasm.wasmPaths  = _distUrl;
  ort.env.wasm.numThreads = 1;
}

let _session        = null;
let _modelInputWidth = 8;   // updated after each load via _probeWidth()

// Probe the model's expected input width by running dummy tensors.
// Tries widths in order — first match wins. Avoids relying on unstable
// session metadata APIs that differ between onnxruntime-web and -node.
async function _probeWidth(session) {
  for (const w of [13, 11, 8]) {
    try {
      const dummy = new ort.Tensor("float32", new Float32Array(w).fill(0), [1, w]);
      await session.run({ float_input: dummy });
      return w;
    } catch (_) { /* try next */ }
  }
  return 8;  // safe fallback
}

async function _loadSession(sourceUrl) {
  const session = await ort.InferenceSession.create(sourceUrl, {
    executionProviders:     _execProviders,
    graphOptimizationLevel: "all",
  });
  _modelInputWidth = await _probeWidth(session);
  return session;
}

async function _load() {
  try {
    const _modelRef = new URL("../models/signal_model.onnx", import.meta.url);
    const modelUrl  = _isNodeRuntime ? _modelRef.pathname : _modelRef.href;
    _session = await _loadSession(modelUrl);
    self.postMessage({ type: "inference_ready" });
    console.info("[inference] model loaded — inputs:", _session.inputNames,
      "outputs:", _session.outputNames, "width:", _modelInputWidth);
  } catch (err) {
    console.error("[inference] load failed:", err);
    self.postMessage({ type: "inference_error", error: err.message });
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === "init") {
    await _load();
    return;
  }

  if (msg.type === "reload_model") {
    try {
      const raw        = msg.model_bytes ?? msg.buffer;
      const newSession = await ort.InferenceSession.create(new Uint8Array(raw), {
        executionProviders:     _execProviders,
        graphOptimizationLevel: "all",
      });
      _modelInputWidth = await _probeWidth(newSession);
      _session         = newSession;
      self.postMessage({ type: "inference_ready", retrained: true });
      console.info("[inference] hot-reloaded retrained model — width:", _modelInputWidth);
    } catch (err) {
      console.error("[inference] hot-reload failed:", err);
      self.postMessage({ type: "inference_error", error: err.message });
    }
    return;
  }

  if (msg.type === "infer") {
    if (!_session) return;

    const { features, pattern_id, regime_tag, fee, slippage } = msg;

    try {
      // Fit feature vector to whatever width this model expects.
      // Trim if too long (old model still loaded), zero-pad if too short.
      const w = _modelInputWidth;
      const featureVec = features.length >= w
        ? features.slice(0, w)
        : [...features, ...Array(w - features.length).fill(0)];

      const tensor  = new ort.Tensor("float32", Float32Array.from(featureVec), [1, w]);
      const results = await _session.run({ float_input: tensor });

      // skl2onnx (zipmap=false): "probabilities" Float32[1,2] → [P(down), P(up)]
      const probs       = results["probabilities"].data;
      const pUp         = probs[1];
      const gross_delta = (pUp - 0.5) * 0.03;

      self.postMessage({
        type:        "inference_result",
        pattern_id,
        regime_tag,
        gross_delta: +gross_delta.toFixed(7),
        p_up:        +pUp.toFixed(4),
        features,    // echo back so main thread can attach to outcome log
        fee,
        slippage,
        timestamp:   Date.now(),
      });
    } catch (err) {
      console.error("[inference] run failed:", err);
    }
  }
};
