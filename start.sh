#!/usr/bin/env bash
# EchoForge start script — local development stack
#
# Usage:
#   ./start.sh              # start everything (prompts for mode)
#   ./start.sh --local      # local processes (recommended for dev)
#   ./start.sh --compose    # Docker Compose for mock-valr + NATS + tracker
#   ./start.sh --no-nats    # skip NATS (telemetry disabled)
#   ./start.sh --no-dash    # skip Next.js dashboard
#   ./start.sh stop         # stop Docker Compose stack + local processes
#   ./start.sh logs         # tail Compose logs
#   ./start.sh restart-daemon  # hot-restart daemon only (keeps Docker + browser running)
#
# Architecture:
#   mock-valr (:8766) → daemon/runner.js (:8767 IPC) → EchoForgeExtension (Python)
#   browser/serve.py (:8080)  — browser node (SharedArrayBuffer / WebGPU)
#   NATS (:4222)              — optional telemetry backbone
#   tracker (:8888)           — optional Trystero WebRTC signaling
#   dashboard (:3001)         — optional Next.js PHIC dashboard

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────
BOLD="\033[1m"; RESET="\033[0m"
GREEN="\033[0;32m"; CYAN="\033[0;36m"; YELLOW="\033[0;33m"; RED="\033[0;31m"

info()    { echo -e "${CYAN}▸ $*${RESET}"; }
success() { echo -e "${GREEN}✓ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠ $*${RESET}"; }
die()     { echo -e "${RED}✗ $*${RESET}" >&2; exit 1; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BROWSER_DIR="$SCRIPT_DIR/browser"
DAEMON_DIR="$SCRIPT_DIR/daemon"
DASHBOARD_DIR="$SCRIPT_DIR/dashboard"
SIGNALING_DIR="$SCRIPT_DIR/signaling"
MOCK_VALR="$SCRIPT_DIR/tests/mock_valr/server.py"

# ── Env defaults ───────────────────────────────────────────────────────────
MOCK_VALR_PORT="${MOCK_VALR_PORT:-8766}"
DAEMON_IPC_PORT="${DAEMON_IPC_PORT:-8767}"
BROWSER_PORT="${BROWSER_PORT:-8080}"
TRACKER_PORT="${TRACKER_PORT:-8888}"
NATS_PORT="${NATS_PORT:-4222}"
DASHBOARD_PORT="${DASHBOARD_PORT:-3001}"
NATS_URL="${NATS_URL:-nats://localhost:$NATS_PORT}"

# Load .env if present
[ -f "$SCRIPT_DIR/.env" ] && set -a && source "$SCRIPT_DIR/.env" && set +a

# ── PID tracking (local mode) ──────────────────────────────────────────────
PIDS=()
LOG_DIR="$SCRIPT_DIR/.logs"

cleanup() {
  echo ""
  info "Shutting down..."
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  success "All processes stopped."
}

# ── Helpers ────────────────────────────────────────────────────────────────
check_cmd() {
  command -v "$1" &>/dev/null || \
    ([ -x "$HOME/.bun/bin/$1" ] && export PATH="$HOME/.bun/bin:$PATH") || \
    die "'$1' not found — please install it first."
}

port_free() {
  ! lsof -i ":$1" -sTCP:LISTEN -t &>/dev/null
}

wait_for_port() {
  local port=$1 name=$2 tries=30
  info "Waiting for $name on :$port..."
  while ! nc -z localhost "$port" 2>/dev/null; do
    sleep 0.5
    ((tries--)) || die "$name failed to start on :$port"
  done
  success "$name ready on :$port"
}

log_file() { echo "$LOG_DIR/$1.log"; }

start_bg() {
  local name=$1; shift
  mkdir -p "$LOG_DIR"
  "$@" >"$(log_file "$name")" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  echo "$pid" > "$LOG_DIR/$name.pid"
  info "$name started (pid $pid) — logs: $(log_file "$name")"
}

bun_cmd() {
  # Resolve bun from PATH or ~/.bun/bin
  if command -v bun &>/dev/null; then
    bun "$@"
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    "$HOME/.bun/bin/bun" "$@"
  else
    die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  fi
}

# Resolve the actual bun binary path (needed when passing to env/exec, where shell functions don't work)
resolve_bun() {
  if command -v bun &>/dev/null; then
    command -v bun
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    echo "$HOME/.bun/bin/bun"
  else
    die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  fi
}

show_urls() {
  header "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "  ${BOLD}EchoForge stack is running${RESET}"
  echo ""
  echo -e "  ${GREEN}Browser node${RESET}    http://localhost:$BROWSER_PORT"
  [[ "${USE_DASH:-true}" == "true" ]] && \
    echo -e "  ${GREEN}PHIC dashboard${RESET}  http://localhost:$DASHBOARD_PORT/echoforge"
  echo -e "  ${GREEN}Daemon IPC${RESET}      ws://localhost:$DAEMON_IPC_PORT  (Python extension)"
  echo -e "  ${GREEN}Mock VALR${RESET}       http://localhost:$MOCK_VALR_PORT/mock/state"
  echo -e "  ${GREEN}Tracker${RESET}         ws://localhost:$TRACKER_PORT"
  [[ "${USE_NATS:-true}" == "true" ]] && \
    echo -e "  ${GREEN}NATS monitor${RESET}    http://localhost:8222"
  echo ""
  echo -e "  ${YELLOW}Browser UI → open http://localhost:$BROWSER_PORT${RESET}"
  echo -e "  ${YELLOW}Inject toxicity: curl -X POST localhost:$MOCK_VALR_PORT/mock/toxicity${RESET}"
  echo -e "  ${YELLOW}Retrain model:   ruvon start EchoForgeModelRetrain --data '{\"pair\":\"BTC/USDT\"}'${RESET}"
  echo -e "  ${YELLOW}Emergency freeze: ruvon start EchoForgeEmergencyFreeze --data '{\"vpin\":0.95,\"regime_tag\":\"Crisis\"}'${RESET}"
  header "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Preflight ──────────────────────────────────────────────────────────────
preflight_local() {
  check_cmd python

  # bun is required for the daemon
  if ! command -v bun &>/dev/null && ! [ -x "$HOME/.bun/bin/bun" ]; then
    die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  fi
  export PATH="$HOME/.bun/bin:$PATH"

  # Daemon dependencies — always sync so new package.json entries are picked up
  (cd "$DAEMON_DIR" && bun_cmd install --frozen-lockfile 2>/dev/null || bun_cmd install --silent)

  # Optional dashboard dependencies
  if [[ "${USE_DASH:-true}" == "true" ]] && [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
    info "Installing dashboard dependencies..."
    npm --prefix "$DASHBOARD_DIR" install --silent
  fi

  if [ ! -d "$SIGNALING_DIR/node_modules" ]; then
    info "Installing tracker dependencies..."
    npm --prefix "$SIGNALING_DIR" install --silent
  fi
}

# ── Local mode ─────────────────────────────────────────────────────────────
run_local() {
  trap cleanup EXIT INT TERM
  preflight_local

  header "Starting EchoForge (local processes)..."

  # 1 — NATS (optional telemetry backbone)
  if [[ "${USE_NATS:-true}" == "true" ]]; then
    if command -v nats-server &>/dev/null; then
      port_free "$NATS_PORT" || warn "Port $NATS_PORT in use — NATS may already be running"
      if [ -f "$SCRIPT_DIR/nats.conf" ]; then
        start_bg nats nats-server -config "$SCRIPT_DIR/nats.conf" -p "$NATS_PORT"
      else
        start_bg nats nats-server -js -m 8222 -p "$NATS_PORT"
      fi
      wait_for_port "$NATS_PORT" "NATS"
    elif command -v docker &>/dev/null; then
      info "nats-server not found — using Docker for NATS"
      docker rm -f echoforge-nats 2>/dev/null || true
      docker run -d --name echoforge-nats \
        -p "$NATS_PORT:4222" -p "8222:8222" \
        nats:2.10-alpine -js -m 8222 >/dev/null
      PIDS+=("$(docker inspect -f '{{.State.Pid}}' echoforge-nats 2>/dev/null || echo 0)")
      wait_for_port "$NATS_PORT" "NATS"
    else
      warn "NATS skipped (no nats-server or docker). Telemetry will be disabled."
      USE_NATS=false
    fi
  fi

  # 2 — Mock VALR exchange (tick data source)
  if port_free "$MOCK_VALR_PORT"; then
    start_bg mock-valr \
      python "$MOCK_VALR" --host 0.0.0.0 --port "$MOCK_VALR_PORT"
    wait_for_port "$MOCK_VALR_PORT" "Mock VALR"
  else
    warn "Port $MOCK_VALR_PORT in use — assuming mock VALR already running"
  fi

  # 3 — Bun daemon (JS worker subprocess, connects to mock-valr)
  if ! port_free "$DAEMON_IPC_PORT"; then
    warn "Port $DAEMON_IPC_PORT busy — killing existing daemon before restart"
    _stale=$(lsof -ti ":$DAEMON_IPC_PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$_stale" ] && kill "$_stale" 2>/dev/null && sleep 1 || true
  fi
  local BUN_BIN
  BUN_BIN="$(resolve_bun)"
  start_bg daemon env \
    ECHOFORGE_EXCHANGE_URL="http://localhost:$MOCK_VALR_PORT" \
    ECHOFORGE_IPC_PORT="$DAEMON_IPC_PORT" \
    "$BUN_BIN" --cwd "$DAEMON_DIR" start
  wait_for_port "$DAEMON_IPC_PORT" "EchoForge daemon"

  # 4 — Trystero tracker (WebRTC signaling for browser mesh)
  if port_free "$TRACKER_PORT"; then
    start_bg tracker \
      env TRACKER_PORT="$TRACKER_PORT" node "$SIGNALING_DIR/tracker.js"
    wait_for_port "$TRACKER_PORT" "Tracker"
  else
    warn "Port $TRACKER_PORT in use — skipping tracker (using openwebtorrent.com)"
  fi

  # 5 — Browser node server (COOP/COEP headers for SharedArrayBuffer + WebGPU)
  if port_free "$BROWSER_PORT"; then
    start_bg browser-serve \
      python "$BROWSER_DIR/serve.py" "$BROWSER_PORT"
    wait_for_port "$BROWSER_PORT" "Browser server"
  else
    warn "Port $BROWSER_PORT in use — browser server may already be running"
  fi

  # 6 — Dashboard (optional Next.js PHIC UI)
  if [[ "${USE_DASH:-true}" == "true" ]]; then
    if port_free "$DASHBOARD_PORT"; then
      start_bg dashboard \
        env NEXT_PUBLIC_DAEMON_WS="ws://localhost:$DAEMON_IPC_PORT" \
        npm --prefix "$DASHBOARD_DIR" run dev -- -p "$DASHBOARD_PORT"
      local tries=30
      info "Waiting for dashboard (Next.js compile)..."
      while ! nc -z localhost "$DASHBOARD_PORT" 2>/dev/null; do
        sleep 1
        ((tries--)) || { warn "Dashboard slow to start — check $(log_file dashboard)"; break; }
      done
      nc -z localhost "$DASHBOARD_PORT" 2>/dev/null && success "Dashboard ready on :$DASHBOARD_PORT"
    else
      warn "Port $DASHBOARD_PORT in use — skipping dashboard"
    fi
  fi

  show_urls
  echo -e "  ${BOLD}Logs:${RESET} $LOG_DIR/"
  echo -e "  Press ${BOLD}Ctrl-C${RESET} to stop all processes.\n"

  wait
}

# ── Docker Compose mode ────────────────────────────────────────────────────
# Compose runs: NATS + mock-valr + tracker (+ optional dashboard)
# The Bun daemon and browser server run locally (need filesystem access to browser/).
run_compose() {
  check_cmd docker
  docker compose version &>/dev/null || die "docker compose not available"

  # bun still needed for the daemon (runs locally even in compose mode)
  if ! command -v bun &>/dev/null && ! [ -x "$HOME/.bun/bin/bun" ]; then
    die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  fi
  export PATH="$HOME/.bun/bin:$PATH"

  (cd "$DAEMON_DIR" && bun_cmd install --frozen-lockfile 2>/dev/null || bun_cmd install --silent)

  cd "$SCRIPT_DIR"

  local profile_flag=""
  [[ "${USE_DASH:-false}" == "true" ]] && profile_flag="--profile full"

  # Remove standalone echoforge-nats if it exists — it would conflict with compose's NATS service
  docker rm -f echoforge-nats 2>/dev/null || true

  header "Starting EchoForge (Docker Compose + local daemon)..."
  docker compose $profile_flag up --build -d

  # Wait for mock-valr before starting daemon
  wait_for_port "$MOCK_VALR_PORT" "Mock VALR (Docker)"

  # Daemon runs locally (needs filesystem access to browser/ workers + models/)
  DAEMON_PID=""
  if ! port_free "$DAEMON_IPC_PORT"; then
    warn "Port $DAEMON_IPC_PORT busy — killing existing daemon before restart"
    _stale=$(lsof -ti ":$DAEMON_IPC_PORT" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$_stale" ] && kill "$_stale" 2>/dev/null && sleep 1 || true
  fi
  mkdir -p "$LOG_DIR"
  ECHOFORGE_EXCHANGE_URL="http://localhost:$MOCK_VALR_PORT" \
  ECHOFORGE_IPC_PORT="$DAEMON_IPC_PORT" \
  bun_cmd --cwd "$DAEMON_DIR" start >"$LOG_DIR/daemon.log" 2>&1 &
  DAEMON_PID=$!
  echo "$DAEMON_PID" > "$LOG_DIR/daemon.pid"
  info "daemon started (pid $DAEMON_PID) — logs: $LOG_DIR/daemon.log"
  wait_for_port "$DAEMON_IPC_PORT" "EchoForge daemon"

  # Browser server runs locally (COOP/COEP headers can't be set in plain nginx/Docker)
  BROWSER_PID=""
  if port_free "$BROWSER_PORT"; then
    python "$BROWSER_DIR/serve.py" "$BROWSER_PORT" >"$LOG_DIR/browser-serve.log" 2>&1 &
    BROWSER_PID=$!
    echo "$BROWSER_PID" > "$LOG_DIR/browser-serve.pid"
    info "browser-serve started (pid $BROWSER_PID)"
  fi
  trap "kill ${DAEMON_PID:-} ${BROWSER_PID:-} 2>/dev/null; docker compose stop" EXIT INT TERM
  [ -n "$BROWSER_PID" ] && wait_for_port "$BROWSER_PORT" "Browser server"

  show_urls
  echo -e "  ${BOLD}Daemon logs:${RESET}   $LOG_DIR/daemon.log"
  echo -e "  ${BOLD}Compose logs:${RESET}  docker compose logs -f"
  echo -e "  ${BOLD}Stop compose:${RESET}  docker compose stop\n"
  echo -e "  Press ${BOLD}Ctrl-C${RESET} to stop local processes (Compose runs in background).\n"

  wait
}

# ── Stop / logs helpers ────────────────────────────────────────────────────
run_stop() {
  # Stop any locally tracked PIDs
  for pidfile in "$LOG_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile")
    kill "$pid" 2>/dev/null && info "Stopped pid $pid ($(basename "$pidfile" .pid))" || true
    rm -f "$pidfile"
  done

  if command -v docker &>/dev/null; then
    # Remove standalone echoforge-nats container (started by local mode's Docker NATS fallback)
    if docker inspect echoforge-nats &>/dev/null 2>&1; then
      info "Removing standalone NATS container..."
      docker rm -f echoforge-nats 2>/dev/null || true
    fi

    if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
      info "Stopping Docker Compose stack..."
      cd "$SCRIPT_DIR" && docker compose down --remove-orphans 2>/dev/null || true
    fi
  fi
  success "Stack stopped."
}

run_logs() {
  cd "$SCRIPT_DIR"
  if [ -d "$LOG_DIR" ]; then
    info "Local logs in $LOG_DIR — tailing daemon + mock-valr..."
    tail -f "$LOG_DIR/daemon.log" "$LOG_DIR/mock-valr.log" 2>/dev/null &
  fi
  docker compose logs -f 2>/dev/null || true
  wait
}

run_restart_daemon() {
  # Kill any process holding the daemon IPC port (by port + by PID file)
  _stale=$(lsof -ti ":$DAEMON_IPC_PORT" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$_stale" ]; then
    kill "$_stale" 2>/dev/null && info "Stopped daemon (pid $_stale)" || true
    sleep 1
  fi
  if [ -f "$LOG_DIR/daemon.pid" ]; then
    _pid=$(cat "$LOG_DIR/daemon.pid")
    kill "$_pid" 2>/dev/null || true
    rm -f "$LOG_DIR/daemon.pid"
  fi
  # Require mock-valr to be up before starting daemon
  wait_for_port "$MOCK_VALR_PORT" "Mock VALR"
  mkdir -p "$LOG_DIR"
  ECHOFORGE_EXCHANGE_URL="http://localhost:$MOCK_VALR_PORT" \
  ECHOFORGE_IPC_PORT="$DAEMON_IPC_PORT" \
  bun_cmd --cwd "$DAEMON_DIR" start >>"$LOG_DIR/daemon.log" 2>&1 &
  _new_pid=$!
  echo "$_new_pid" > "$LOG_DIR/daemon.pid"
  success "Daemon restarted (pid $_new_pid) — logs: $LOG_DIR/daemon.log"
  wait_for_port "$DAEMON_IPC_PORT" "EchoForge daemon"
}

# ── Argument parsing ───────────────────────────────────────────────────────
MODE=""
USE_NATS=true
USE_DASH=true

for arg in "$@"; do
  case "$arg" in
    --compose)  MODE=compose ;;
    --local)    MODE=local ;;
    --no-nats)  USE_NATS=false ;;
    --no-dash)  USE_DASH=false ;;
    stop)             run_stop; exit 0 ;;
    logs)             run_logs; exit 0 ;;
    restart-daemon)   run_restart_daemon; exit 0 ;;
    -h|--help)
      echo "Usage: $0 [--compose|--local] [--no-nats] [--no-dash]"
      echo "       $0 stop"
      echo "       $0 logs"
      echo "       $0 restart-daemon   # hot-restart daemon only (keeps Docker + browser running)"
      exit 0 ;;
    *) die "Unknown argument: $arg" ;;
  esac
done

# ── Mode selection ─────────────────────────────────────────────────────────
if [[ -z "$MODE" ]]; then
  echo ""
  echo -e "${BOLD}EchoForge${RESET}"
  echo ""
  echo "  1) Local processes  (recommended — mock-valr + daemon + browser, no Docker)"
  echo "  2) Docker Compose   (NATS + mock-valr + tracker in Docker, daemon runs local)"
  echo ""
  read -rp "  Choose [1/2]: " choice
  case "$choice" in
    1) MODE=local ;;
    2) MODE=compose ;;
    *) die "Invalid choice" ;;
  esac
fi

case "$MODE" in
  local)   run_local ;;
  compose) run_compose ;;
esac
