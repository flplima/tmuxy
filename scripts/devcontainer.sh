#!/usr/bin/env bash
#
# Start the devcontainer and run Claude Code in YOLO mode.
#
# Mounts host credentials (Claude, Git, GitHub CLI, SSH) so you don't
# need to re-authenticate inside the container. A firewall restricts
# outbound traffic to whitelisted domains only.
#
# Multiple instances can run simultaneously from different worktrees —
# each gets a unique container name and a free host port for the dev server.
#
# Usage:
#   npm run devcontainer          # Build (if needed) + run
#   npm run devcontainer:build    # Build image only
#

set -e

cd "$(dirname "$0")/.."

IMAGE_NAME="tmuxy-dev"
DOCKERFILE=".devcontainer/Dockerfile"

# ---------------------------------------------------------------------------
# Unique container name from workspace directory
# ---------------------------------------------------------------------------
DIR_NAME="$(basename "$(pwd)")"
CONTAINER_NAME="tmuxy-${DIR_NAME//[^a-zA-Z0-9_.-]/-}"

# ---------------------------------------------------------------------------
# Build image
# ---------------------------------------------------------------------------
if [ "$1" = "--build" ] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Building devcontainer image..."
    docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" .
    [ "$1" = "--build" ] && exit 0
fi

# ---------------------------------------------------------------------------
# Clean up leftover container from a previous crashed run
# ---------------------------------------------------------------------------
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Find a free host port for the dev server (9000-9099)
# ---------------------------------------------------------------------------
HOST_PORT=""
for port in $(seq 9000 9099); do
    if ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
        HOST_PORT=$port
        break
    fi
done

if [ -z "$HOST_PORT" ]; then
    echo "ERROR: No free port in range 9000-9099" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Assemble volume mounts
# ---------------------------------------------------------------------------
MOUNTS=(
    # Workspace (each worktree maps its own directory)
    -v "$(pwd):/workspace"
    # Claude config/credentials from host
    -v "$HOME/.claude:/home/node/.claude"
    # Cargo cache (shared across instances — cargo uses file locks)
    -v tmuxy-cargo-registry:/usr/local/cargo/registry
    -v tmuxy-cargo-git:/usr/local/cargo/git
)

# Host credentials (mounted read-only, skipped if missing)
[ -f "$HOME/.gitconfig" ] && MOUNTS+=(-v "$HOME/.gitconfig:/home/node/.gitconfig:ro")
[ -d "$HOME/.ssh" ]       && MOUNTS+=(-v "$HOME/.ssh:/home/node/.ssh:ro")
[ -d "$HOME/.config/gh" ] && MOUNTS+=(-v "$HOME/.config/gh:/home/node/.config/gh:ro")

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "==> Container: $CONTAINER_NAME"
echo "==> Dev server: http://localhost:$HOST_PORT"
echo ""

exec docker run -it --rm \
    --name "$CONTAINER_NAME" \
    --cap-add=NET_ADMIN \
    --cap-add=NET_RAW \
    --init \
    --memory=6g \
    --shm-size=1g \
    --pids-limit=50000 \
    -p "$HOST_PORT:9000" \
    "${MOUNTS[@]}" \
    -e PORT=9000 \
    -e HOST_PORT="$HOST_PORT" \
    -e CHROME_CDP_URL=http://localhost:9222 \
    -e TMUX_SESSION=dev \
    -w /workspace \
    -u node \
    "$IMAGE_NAME" \
    bash -lc '
        sudo /usr/local/bin/init-firewall.sh
        ln -sf /workspace/docker/.tmuxy.conf ~/.tmuxy.conf
        ln -sf /workspace/docker/.tmux-dev.conf ~/.tmux.conf
        claude --dangerously-skip-permissions
    '
