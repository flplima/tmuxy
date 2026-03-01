#!/usr/bin/env bash
#
# Development server with hot reload
#
# - Watches Rust files (tmuxy-core, tmuxy-server) and rebuilds/restarts on change
# - Vite HMR is handled automatically via the tmuxy-server dev mode proxy
#
# Usage:
#   npm start  # Run in background with pm2
#   npm stop   # Stop the server
#   npm logs   # View logs
#

set -e

cd /workspace

# Cleanup function for graceful shutdown
cleanup() {
    echo "[dev] Shutting down..."
    jobs -p | xargs -r kill 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "[dev] Starting development server with hot reload..."
echo "[dev] Watching: packages/tmuxy-core/src, packages/tmuxy-server/src"
echo "[dev] Vite HMR is automatic via proxy to port 1420"
echo ""

# Kill any existing tmuxy session, then start the server with file watching
tmux kill-session -t tmuxy 2>/dev/null || true
exec cargo watch \
    -w packages/tmuxy-core/src \
    -w packages/tmuxy-server/src \
    -x 'run -p tmuxy-server -- --dev'
