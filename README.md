# ruvon-echoforge

**EchoForge Syndicate** — sovereign, browser-first distributed quant intelligence mesh.

Each node runs autonomous Rust/Wasm sentinels in Web Workers, pools pattern intelligence
(never capital) with peers via WebRTC, and is governed by a PHIC (Partial Human In Control)
dashboard.

## Quick Start

### Option A — Docker Compose (recommended)

```bash
cd packages/ruvon-echoforge
docker compose up           # NATS + bridge + mock-valr + tracker
```

Then open the browser node:
```bash
python browser/serve.py     # http://localhost:8080
```

Add the PHIC dashboard (separate terminal):
```bash
cd dashboard && npm run dev  # http://localhost:3001/echoforge
```

### Option B — Local processes (no Docker)

**1. NATS** (optional — PHIC config is non-fatal without it)
```bash
docker run -d --name nats -p 4222:4222 -p 8222:8222 nats:2.10-alpine -js -m 8222
# or: brew install nats-server && nats-server -js
```

**2. Bridge**
```bash
pip install -e "packages/ruvon-echoforge"
NATS_URL=nats://localhost:4222 echoforge   # ws://localhost:8765
```

**3. Mock VALR exchange** (instead of real VALR)
```bash
python -m ruvon_echoforge.tests.mock_valr.server   # port 8766
# inject toxicity:  curl -X POST localhost:8766/mock/toxicity
```

**4. Trystero tracker** (instead of openwebtorrent.com)
```bash
cd packages/ruvon-echoforge/signaling && npm install && npm start  # ws://localhost:8888
```

**5. Browser node**
```bash
python packages/ruvon-echoforge/browser/serve.py   # http://localhost:8080
# In the UI → set Relay URL: ws://localhost:8888 (if using local tracker)
```

**6. PHIC dashboard**
```bash
cd packages/ruvon-echoforge/dashboard
npm install && npm run dev   # http://localhost:3001/echoforge
```

### Ports at a glance

| Service | Port | Protocol |
|---|---|---|
| Bridge | 8765 | HTTP + WS |
| Mock VALR | 8766 | HTTP + WS |
| Browser node | 8080 | HTTP |
| Trystero tracker | 8888 | WS |
| NATS | 4222 | TCP |
| NATS monitoring | 8222 | HTTP |
| PHIC dashboard | 3001 | HTTP |

### NATS subjects

| Subject | Direction | Content |
|---|---|---|
| `echoforge.phic.config` | bridge → subscribers | PHIC config change JSON |

### Env vars

| Var | Default | Description |
|---|---|---|
| `NATS_URL` | *(unset — NATS disabled)* | e.g. `nats://localhost:4222` |
| `ECHOFORGE_PORT` | `8765` | Bridge listen port |
| `ECHOFORGE_CORS_ORIGINS` | `*` | Comma-separated allowed origins |

Open `browser/index.html` in a COOP/COEP-enabled server to launch a node.

## Architecture

```
Browser Node
├── Worker 1: OrderBook + Depth Sentinel   (ring buffer writer)
├── Worker 2: Nociceptor + Metabolic       (ring buffer reader)
├── Worker 3: EchoForge Decay + Gossip     (aliveness memory)
└── Worker 4: Execution Router + SAF       (exchange submission)
     ↕ SharedArrayBuffer ring buffer (1MB, 65k ticks)
     ↕ WebRTC DataChannels (P2P gossip)
     ↕ WebSocket bridge (FastAPI)

FastAPI Bridge (Python)
├── /api/v1/tick       WebSocket tick ingestion
├── /api/v1/phic/config  PHIC governance API
└── /api/v1/metrics    WebSocket telemetry push
```

## Sentinel Logic

| Sentinel | Trigger | Action |
|---|---|---|
| Nociceptor | VPIN > 0.70 | CANCEL_ORDERS |
| Proprioceptor | Latency > 150ms or skew > 50ms | FORCE_PASSIVE |
| Metabolic | NetAlpha < fee hurdle | DROP_SIGNAL |

## Privacy Guarantee

Only `pattern_id + net_aliveness + regime_tag` crosses P2P channels.
No capital, keys, balances, or trade history leaves the local node.
