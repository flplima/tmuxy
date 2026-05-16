#!/usr/bin/env bash
# Symlink ~/.claude.json into the persisted ~/.claude volume so Claude Code's
# login/onboarding state survives container rebuilds.
#
# Why this is needed:
#   - ~/.claude/ (incl. .credentials.json with OAuth refresh token) is on a
#     named volume.
#   - ~/.claude.json (onboarding flag, oauthAccount, MCP/trust settings) sits
#     at $HOME/.claude.json, OUTSIDE the volume. CLAUDE_CONFIG_DIR does not
#     relocate it. Docker named volumes can only target directories.
#   - Solution: keep the real file inside the volume at ~/.claude/.claude.json
#     and symlink ~/.claude.json -> that path.
set -euo pipefail

REAL=/home/user/.claude/.claude.json
LINK=/home/user/.claude.json

# First-run migration: if the canonical path holds a real file (created during
# image build or a previous interactive login) and the volume copy doesn't
# exist yet, move it into the volume so the data isn't lost.
if [ -f "$LINK" ] && [ ! -L "$LINK" ] && [ ! -e "$REAL" ]; then
  mv "$LINK" "$REAL"
fi

# Ensure the volume copy exists so the symlink resolves on first start.
if [ ! -e "$REAL" ]; then
  install -m 600 /dev/null "$REAL"
  echo '{}' > "$REAL"
fi

ln -sf "$REAL" "$LINK"
