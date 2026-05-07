#!/usr/bin/env bash
# EchoForge NATS JetStream stream provisioner
# Run once after `docker compose up` to create durable streams.
#
# Usage:
#   ./nats-stream-setup.sh                    # default nats://localhost:4222
#   NATS_URL=nats://remote:4222 ./nats-stream-setup.sh

set -euo pipefail

NATS_URL="${NATS_URL:-nats://localhost:4222}"
NATS_CLI="nats"

# Check nats CLI is available
if ! command -v "$NATS_CLI" &>/dev/null; then
  echo "[nats-setup] 'nats' CLI not found. Install: brew install nats-io/nats-tools/nats"
  echo "[nats-setup] Or: go install github.com/nats-io/natscli/nats@latest"
  exit 1
fi

echo "[nats-setup] Connecting to ${NATS_URL}"

create_or_update_stream() {
  local name="$1"; shift
  local subjects="$1"; shift
  local max_age="$1"; shift

  if $NATS_CLI --server "$NATS_URL" stream info "$name" &>/dev/null 2>&1; then
    echo "[nats-setup] Stream '$name' already exists — updating"
    $NATS_CLI --server "$NATS_URL" stream edit "$name" \
      --subjects "$subjects" \
      --max-age  "$max_age"  \
      --replicas 1 2>/dev/null || true
  else
    echo "[nats-setup] Creating stream '$name'"
    $NATS_CLI --server "$NATS_URL" stream add "$name" \
      --subjects  "$subjects" \
      --storage   file         \
      --replicas  1            \
      --retention limits       \
      --discard   old          \
      --max-age   "$max_age"   \
      --defaults
  fi
}

# PHIC config changes — 24h retention
create_or_update_stream "PHIC_CONFIG"      "echoforge.phic.>"      "24h"

# Execution events (fills, orders, killswitches) — 48h retention
create_or_update_stream "EXECUTION_EVENTS" "echoforge.execution.>" "48h"

# Telemetry (portfolio snapshots, VPIN) — 7d retention
create_or_update_stream "TELEMETRY"        "echoforge.telemetry.>" "7d"

# Forensic snapshots (toxic states, killswitch captures) — 30d retention
create_or_update_stream "FORENSIC"         "echoforge.forensic.>"  "30d"

# Guardian decisions (nacks, state changes, audit trail) — 7d retention
create_or_update_stream "GUARDIAN"         "echoforge.guardian.>"  "7d"

echo "[nats-setup] Done. Streams:"
$NATS_CLI --server "$NATS_URL" stream ls
