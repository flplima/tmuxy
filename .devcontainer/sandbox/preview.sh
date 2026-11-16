#!/usr/bin/env bash
#
# Start a sandbox's preview stack on demand (bin/sandbox preview): the dev
# server with its Vite, and Storybook under /storybook/, both behind the Caddy
# that init.sh already runs. Idempotent: a running part is left alone.
set -euo pipefail

WS=/workspaces/tmuxy
READY=/tmp/sandbox-ready
SB_LOG=/tmp/sandbox-storybook.log

# Wait for init.sh's clone and install; "not ready yet" means keep waiting.
if [ ! -f "$READY" ]; then
    echo "[sandbox] waiting for the clone and npm ci (bin/sandbox logs <slug> -f to watch)"
    until [ -f "$READY" ]; do sleep 2; done
fi
cd "$WS"

answers() { curl -s -o /dev/null --max-time 2 "$1"; }

# Loopback only: Caddy is the one way in. A cold cargo build takes minutes, so
# the start waits longer than its default.
DEV_START_TIMEOUT="${DEV_START_TIMEOUT:-1800}" TMUXY_DEV_HOST=127.0.0.1 bin/dev-server start

if ! answers http://127.0.0.1:6006/; then
    # setsid, so it outlives this `docker exec`; it execs in place here (a
    # background job is not a group leader), so $! is npm's own pid.
    setsid nohup npm run storybook -w tmuxy-ui -- --ci --quiet </dev/null >"$SB_LOG" 2>&1 &
    sb_pid=$!
    echo "[sandbox] starting Storybook"
    until answers http://127.0.0.1:6006/; do
        if ! kill -0 "$sb_pid" 2>/dev/null; then
            echo "[sandbox] Storybook exited; last lines of $SB_LOG:" >&2
            tail -20 "$SB_LOG" >&2
            exit 1
        fi
        sleep 1
    done
fi
echo "[sandbox] preview up"
