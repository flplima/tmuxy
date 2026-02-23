#!/usr/bin/env bash
#
# Start the devcontainer with an interactive shell or a custom command.
#
# Mounts host credentials (Claude, Git, GitHub CLI, SSH) so you don't
# need to re-authenticate inside the container.
#
# Multiple instances can run simultaneously from different worktrees —
# each gets a unique container name and a free host port for the dev server.
#
# Usage:
#   npm run devcontainer              # Build (if needed) + shell
#   npm run devcontainer:build        # Build image only
#   npm run yolo-mode                  # Shell + Claude Code in YOLO mode
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
CONTAINER_CMD=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --build) BUILD_ONLY=1; shift ;;
        --cmd)   CONTAINER_CMD="$2"; shift 2 ;;
        *)       shift ;;
    esac
done

if [ "$BUILD_ONLY" = 1 ] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Building devcontainer image..."
    docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" .
    [ "$BUILD_ONLY" = 1 ] && exit 0
fi

# ---------------------------------------------------------------------------
# Clean up leftover container from a previous crashed run
# ---------------------------------------------------------------------------
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Deterministic host port from workspace directory path (10000-20000)
# Each worktree gets a unique, stable port derived from its absolute path
# via cksum. The modulo ensures the result is in the 10000-20000 range.
# ---------------------------------------------------------------------------
HOST_PORT=$(echo -n "$PWD" | cksum | awk '{print 10000 + ($1 % 10001)}')

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
[ -f "$HOME/.claude.json" ] && MOUNTS+=(-v "$HOME/.claude.json:/home/node/.claude.json")
[ -f "$HOME/.gitconfig" ]   && MOUNTS+=(-v "$HOME/.gitconfig:/home/node/.gitconfig:ro")
[ -d "$HOME/.ssh" ]         && MOUNTS+=(-v "$HOME/.ssh:/home/node/.ssh:ro")
[ -d "$HOME/.config/gh" ]   && MOUNTS+=(-v "$HOME/.config/gh:/home/node/.config/gh:ro")

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "==> Container: $CONTAINER_NAME"
echo "==> Dev server: http://localhost:$HOST_PORT"
echo ""

INIT_SCRIPT='
    ln -sf /workspace/docker/.tmuxy.conf ~/.tmuxy.conf
    ln -sf /workspace/docker/.tmux-dev.conf ~/.tmux.conf
'

exec docker run -it --rm \
    --name "$CONTAINER_NAME" \
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
    bash -lic "${INIT_SCRIPT}${CONTAINER_CMD:-exec bash -l}"
