"""
ruvon-echoforge — Sovereign distributed quant intelligence mesh.

Browser-first architecture:
  - Rust/Wasm sentinels (Nociceptor, Proprioceptor, Metabolic) run in Web Workers
  - SharedArrayBuffer ring buffer for zero-copy tick processing
  - WebRTC DataChannels for private fog network gossip
  - PHIC governance dashboard (Next.js)

Python package provides:
  - FastAPI bridge: tick ingestion, PHIC config API, metrics WebSocket
  - EchoForge engine: Bayesian aliveness decay, pattern registry
  - SAF queue: SQLite-backed exactly-once execution queue
  - Exchange adapters: VALR, Binance
"""

__version__ = "0.1.1"
