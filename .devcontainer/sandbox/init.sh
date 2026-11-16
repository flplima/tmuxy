#!/usr/bin/env bash
#
# A sandbox's main process (bin/sandbox up): the one-port proxy, a private clone
# in the workspace volume, the dependencies, and a tmux server for the agent.
# Runs as the image's non-root `user`. bin/sandbox copies this directory into
# the container before it starts, so nothing here comes from the clone.
#
# Its output is `bin/sandbox logs <slug>`. On a restart over a kept volume the
# clone and the install are skipped.
#
# It ends by exec'ing the proxy, never by waiting on it: a shell parented to
# pid 1 with no CPU time is what `bin/dev-server start` reaps as an orphan
# (packages/tmuxy-cli/bin/tmuxy/reap-orphan-shells), and that SIGKILL would
# take the whole container with it.
set -euo pipefail

: "${SANDBOX_REPO_URL:?}" "${SANDBOX_FROM:?}" "${SANDBOX_BRANCH:?}"
WS=/workspaces/tmuxy
READY=/tmp/sandbox-ready

say() { echo "[sandbox] $*"; }

if [ ! -d "$WS/.git" ]; then
    say "cloning $SANDBOX_FROM from $SANDBOX_REPO_URL"
    git clone --quiet --branch "$SANDBOX_FROM" "$SANDBOX_REPO_URL" "$WS"
    git -C "$WS" switch --quiet -c "$SANDBOX_BRANCH"
fi
cd "$WS"
[ -n "${SANDBOX_GIT_NAME:-}" ] && git config user.name "$SANDBOX_GIT_NAME"
[ -n "${SANDBOX_GIT_EMAIL:-}" ] && git config user.email "$SANDBOX_GIT_EMAIL"
say "on $(git branch --show-current) at $(git rev-parse --short HEAD)"

# Conf symlinks and the tmuxy CLI link, as in every other container.
bash .devcontainer/setup.sh

if [ ! -f node_modules/.tmuxy-installed ]; then
    say "npm ci"
    npm ci --no-audit --no-fund
    touch node_modules/.tmuxy-installed
fi
# The placeholders bin/bootstrap makes: the server embeds the UI's dist/, and
# Storybook mounts the two static dirs, built or not.
mkdir -p packages/tmuxy-ui/dist packages/tmuxy-ui/v86-assets packages/tmuxy-wasm/pkg

# The agent's tmux: the default socket, apart from the tmuxy-dev one the
# preview's server uses, so the agent cannot break the view you watch.
tmux has-session -t agent 2>/dev/null || tmux new-session -d -s agent -c "$WS"

touch "$READY"
say "ready"

# The container lives as long as its proxy.
exec caddy run --config /opt/sandbox/Caddyfile --adapter caddyfile
