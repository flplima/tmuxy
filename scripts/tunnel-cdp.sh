#!/usr/bin/env bash
#
# Expose host Chrome CDP (port 9222) inside a running devcontainer
# via SSH reverse tunnel.
#
# Run this on the HOST, not inside the container.
#
# Usage:
#   scripts/tunnel-cdp.sh                  # auto-detect container
#   scripts/tunnel-cdp.sh my-container     # explicit container name
#
# Inside the container, Chrome CDP becomes available at localhost:9222.
#

set -e

# ---------------------------------------------------------------------------
# Resolve container
# ---------------------------------------------------------------------------
if [ -n "$1" ]; then
    CONTAINER_NAME="$1"
else
    DIR_NAME="$(basename "$(cd "$(dirname "$0")/.." && pwd)")"
    CONTAINER_NAME="${DIR_NAME//[^a-zA-Z0-9_.-]/-}"
fi

if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
    echo "Container '$CONTAINER_NAME' not found" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Generate ephemeral SSH key
# ---------------------------------------------------------------------------
TUNNEL_DIR=$(mktemp -d)
TUNNEL_KEY="$TUNNEL_DIR/tunnel_key"
ssh-keygen -t ed25519 -f "$TUNNEL_KEY" -N "" -q

cleanup() {
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
    rm -rf "$TUNNEL_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Inject key and start sshd in container
# ---------------------------------------------------------------------------
docker exec "$CONTAINER_NAME" mkdir -p /home/node/.ssh
docker exec "$CONTAINER_NAME" chmod 700 /home/node/.ssh
docker cp "$TUNNEL_KEY.pub" "$CONTAINER_NAME:/home/node/.ssh/authorized_keys"
docker exec "$CONTAINER_NAME" chmod 600 /home/node/.ssh/authorized_keys
docker exec -u root "$CONTAINER_NAME" /usr/sbin/sshd 2>/dev/null || true

# ---------------------------------------------------------------------------
# Open reverse tunnel: host [::1]:9222 → container localhost:9222
# ---------------------------------------------------------------------------
CONTAINER_IP=$(docker inspect -f '{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER_NAME")

ssh -N -R 9222:[::1]:9222 \
    -i "$TUNNEL_KEY" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ExitOnForwardFailure=yes \
    "node@$CONTAINER_IP" &
TUNNEL_PID=$!

echo "SSH tunnel active: host [::1]:9222 → $CONTAINER_NAME localhost:9222 (pid $TUNNEL_PID)"
echo "Press Ctrl+C to stop"
wait "$TUNNEL_PID"
