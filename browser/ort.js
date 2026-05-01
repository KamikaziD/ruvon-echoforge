/**
 * ort.js — Universal ONNX Runtime shim
 *
 * In a browser Worker: imports onnxruntime-web (WASM)
 * In Node.js / Bun subprocess: imports onnxruntime-node
 *
 * Usage in workers:
 *   import ort from "../ort.js";
 *   // then: ort.Tensor, ort.InferenceSession, ort.env  (all work identically)
 */

"use strict";

const _isNode = typeof process !== "undefined" && process.versions?.node;

let _ort;
if (_isNode) {
  // ECHOFORGE_ORT_PATH is set by runner.js to the absolute resolved path of
  // onnxruntime-node so that browser/ort.js can find it from daemon/node_modules.
  const ortPath = (typeof process !== "undefined" && process.env.ECHOFORGE_ORT_PATH)
    || "onnxruntime-node";
  const mod = await import(ortPath);
  _ort = mod.default ?? mod;
} else {
  const mod = await import("./node_modules/onnxruntime-web/dist/ort.bundle.min.mjs");
  _ort = mod.default ?? mod;
}

export default _ort;
export const { Tensor, InferenceSession, env } = _ort;
