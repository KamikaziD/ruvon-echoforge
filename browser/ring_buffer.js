/**
 * ring_buffer.js — SharedArrayBuffer 1MB lock-free ring buffer for tick data.
 *
 * Tick struct (16 bytes, cache-line friendly):
 *   Offset 0:  float32  price      (4 bytes)
 *   Offset 4:  float32  volume     (4 bytes)
 *   Offset 8:  float32  side       (4 bytes, 0.0=sell 1.0=buy)
 *   Offset 12: uint32   timestamp  (4 bytes, Unix seconds, wraps ~2106)
 *
 * Layout:
 *   [0..3]   write_head (Atomics.store/load, uint32)
 *   [4..7]   read_head  (Atomics.store/load, uint32)
 *   [8..]    tick slots
 *
 * Shared between main thread and Web Workers via postMessage(sab, [sab]).
 */

"use strict";

const HEADER_BYTES = 8;
const TICK_BYTES   = 16;
const BUFFER_SIZE  = 1 * 1024 * 1024; // 1 MB
const CAPACITY     = Math.floor((BUFFER_SIZE - HEADER_BYTES) / TICK_BYTES);

const WRITE_HEAD_OFFSET = 0;
const READ_HEAD_OFFSET  = 1; // Uint32Array index

export function createRingBuffer() {
  const sab  = new SharedArrayBuffer(BUFFER_SIZE);
  const ctrl = new Uint32Array(sab, 0, 2); // [write_head, read_head]
  Atomics.store(ctrl, WRITE_HEAD_OFFSET, 0);
  Atomics.store(ctrl, READ_HEAD_OFFSET, 0);
  return sab;
}

export class RingBufferWriter {
  constructor(sab) {
    this._ctrl  = new Uint32Array(sab, 0, 2);
    this._ticks = new DataView(sab, HEADER_BYTES);
    this._cap   = CAPACITY;
  }

  write(price, volume, side, timestampSec) {
    const head  = Atomics.load(this._ctrl, WRITE_HEAD_OFFSET);
    const slot  = head % this._cap;
    const base  = slot * TICK_BYTES;

    this._ticks.setFloat32(base,      price,        true);
    this._ticks.setFloat32(base + 4,  volume,       true);
    this._ticks.setFloat32(base + 8,  side ? 1.0 : 0.0, true);
    this._ticks.setUint32 (base + 12, timestampSec, true);

    // Release store — advances write head after data is written
    Atomics.store(this._ctrl, WRITE_HEAD_OFFSET, (head + 1) >>> 0);
  }

  get capacity() { return this._cap; }
}

export class RingBufferReader {
  constructor(sab) {
    this._ctrl  = new Uint32Array(sab, 0, 2);
    this._ticks = new DataView(sab, HEADER_BYTES);
    this._cap   = CAPACITY;
    // Start from current write head (skip historical ticks on connect)
    this._local_read = Atomics.load(this._ctrl, WRITE_HEAD_OFFSET);
  }

  /**
   * Read up to `max` ticks. Returns array of {price, volume, side, timestamp}.
   * Non-blocking — returns empty array if no new ticks.
   */
  readBatch(max = 64) {
    const writeHead = Atomics.load(this._ctrl, WRITE_HEAD_OFFSET);
    const available = (writeHead - this._local_read + 0x100000000) % 0x100000000;
    const count     = Math.min(available, max, this._cap);
    if (count === 0) return [];

    const out = [];
    for (let i = 0; i < count; i++) {
      const slot = this._local_read % this._cap;
      const base = slot * TICK_BYTES;
      out.push({
        price:     this._ticks.getFloat32(base,      true),
        volume:    this._ticks.getFloat32(base + 4,  true),
        side:      this._ticks.getFloat32(base + 8,  true) > 0.5 ? "buy" : "sell",
        timestamp: this._ticks.getUint32 (base + 12, true),
      });
      this._local_read = (this._local_read + 1) >>> 0;
    }
    return out;
  }

  get lag() {
    const w = Atomics.load(this._ctrl, WRITE_HEAD_OFFSET);
    return (w - this._local_read + 0x100000000) % 0x100000000;
  }
}
