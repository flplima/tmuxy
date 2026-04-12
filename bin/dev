#!/usr/bin/env bash
#
# Development server with hot reload
#
# - Watches Rust files (tmuxy-core, tmuxy-server) and rebuilds/restarts on change
# - Vite HMR is handled automatically via the tmuxy-server dev mode proxy
#
# Environment variables:
#   TMUX_SOCKET  — tmux named socket (default: none, uses default socket)
#   DEV_PORT     — port to listen on (default: 9000)
#
# Usage:
#   npm start  # Run in background with pm2 (port 9000, default socket)
#   npm stop   # Stop the server
#   npm logs   # View logs
#

set -e

cd /workspace

PORT="${DEV_PORT:-9000}"
SOCKET="${TMUX_SOCKET:-}"

# Cleanup function for graceful shutdown
cleanup() {
    echo "[dev] Shutting down..."
    jobs -p | xargs -r kill 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "[dev] Starting development server with hot reload..."
echo "[dev] Port: $PORT, Socket: ${SOCKET:-default}"
echo "[dev] Watching: packages/tmuxy-core/src, packages/tmuxy-server/src"
echo ""

# Ensure the tmux server has a session so it stays alive between test cycles.
if [ -n "$SOCKET" ]; then
    tmux -L "$SOCKET" has-session -t tmuxy 2>/dev/null \
        || tmux -L "$SOCKET" new-session -d -s tmuxy -x 200 -y 50
else
    tmux kill-session -t tmuxy 2>/dev/null || true
    tmux has-session -t _keepalive 2>/dev/null || tmux new-session -d -s _keepalive
fi

exec cargo watch \
    -w packages/tmuxy-core/src \
    -w packages/tmuxy-server/src \
    -x "run -p tmuxy-server -- --port $PORT --dev"
