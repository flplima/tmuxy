#!/usr/bin/env bash
#
# Development server with hot reload
#
# - Watches Rust files (tmuxy-core, web-server) and restarts on change
# - Vite HMR is handled automatically via the web-server proxy
#
# Usage:
#   ./scripts/dev.sh        # Run with file watching
#   ./scripts/dev.sh --once # Run once without watching (for pm2)
#

set -e

cd /workspace

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[dev]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[dev]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[dev]${NC} $1"
}

log_error() {
    echo -e "${RED}[dev]${NC} $1"
}

# Kill any existing tmuxy tmux session to ensure clean state
kill_tmuxy_session() {
    if tmux has-session -t tmuxy 2>/dev/null; then
        log_warn "Killing existing tmuxy tmux session..."
        tmux kill-session -t tmuxy 2>/dev/null || true
    fi
}

# Cleanup function for graceful shutdown
cleanup() {
    log "Shutting down..."
    # Kill any background processes
    jobs -p | xargs -r kill 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Check for --once flag (run without watching)
if [[ "$1" == "--once" ]]; then
    log "Running in single-run mode (no file watching)"
    exec cargo run -p web-server -- --dev
fi

# Main development loop with file watching
log "Starting development server with hot reload..."
log "Watching: packages/tmuxy-core/**/*.rs, packages/web-server/**/*.rs"
log "Vite HMR is automatic via proxy to port 1420"
echo ""

# Use cargo-watch to watch Rust files and restart the server
# -w: directories to watch
# -s: shell command to run
# -c: clear screen before each run
# -q: quiet cargo-watch output
# --why: show which file changed
exec cargo watch \
    -w packages/tmuxy-core/src \
    -w packages/web-server/src \
    -c \
    --why \
    -s 'tmux kill-session -t tmuxy 2>/dev/null || true; cargo run -p web-server -- --dev'
