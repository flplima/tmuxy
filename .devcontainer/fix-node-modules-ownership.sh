#!/usr/bin/env bash
# Make the container-private node_modules volumes writable by the container user.
#
# A named volume whose target path did not exist in the image is created
# root-owned, so `npm ci` fails for the non-root user with no obvious error.
# Only the mount point is chowned — a populated volume is large and its contents
# are already correct.
#
# Invoked in two contexts, hence the dual privilege handling (same pattern as
# fix-credential-ownership.sh):
#   - bin/devcontainer's entrypoint.sh, as root: chowns directly.
#   - devcontainer.json's onCreateCommand, as `user`: elevates via the scoped
#     NOPASSWD sudoers rule the Dockerfile installs.
# Idempotent and safe to re-run on every container start.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO=sudo; fi

TARGET_UID="${1:-$(id -u)}"
TARGET_GID="${2:-$(id -g)}"

for nm in "$ROOT_DIR/node_modules" "$ROOT_DIR/packages/tmuxy-ui/node_modules"; do
  [ -d "$nm" ] || continue
  if [ "$(stat -c %u "$nm")" != "$TARGET_UID" ]; then
    $SUDO chown "$TARGET_UID:$TARGET_GID" "$nm"
  fi
done
