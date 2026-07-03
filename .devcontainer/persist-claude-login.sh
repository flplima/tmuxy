#!/usr/bin/env bash
# Persist Claude Code login + onboarding state across container rebuilds.
#
# Two pieces of state must survive a fresh container:
#   1. Auth — ~/.claude/.credentials.json. Already lives in the ~/.claude named
#      volume (CLAUDE_CONFIG_DIR points there), so it persists automatically and
#      needs nothing from this script.
#   2. ~/.claude.json — the onboarding flag that skips the welcome/theme screen
#      (plus oauthAccount metadata). This lives in $HOME, OUTSIDE the volume, and
#      CLAUDE_CONFIG_DIR does NOT relocate it. Docker volumes can't target a
#      single file, so we mirror it into the volume and restore it on start.
#
# Why not a symlink: Claude writes ~/.claude.json atomically (tmpfile + rename),
# which REPLACES a symlink with a regular file in $HOME — wiped on recreation.
# So we copy on start and run a polling daemon to copy back.
#
# Must be idempotent and safe to re-run on every container start.
set -euo pipefail

HOME_FILE=/home/user/.claude.json
VOLUME_FILE=/home/user/.claude/.claude.json
DAEMON_PID_FILE=/home/user/.claude/.persist-daemon.pid

# Stop any prior daemon from a previous container generation. The PID file lives
# in the volume so it survives restarts; the process does not (and PIDs aren't
# comparable across containers), so the kill usually fails benignly.
if [ -f "$DAEMON_PID_FILE" ]; then
  kill "$(cat "$DAEMON_PID_FILE")" 2>/dev/null || true
  rm -f "$DAEMON_PID_FILE"
fi

# Restore from the volume copy when the home file is missing or older — i.e. on a
# fresh container the writable layer has no (or a stale) $HOME_FILE, so the
# volume copy wins. When the home file is newer (mid-session edits not yet synced
# up), keep it. `-nt` is true when VOLUME_FILE exists and HOME_FILE does not.
if [ -s "$VOLUME_FILE" ] && [ "$VOLUME_FILE" -nt "$HOME_FILE" ]; then
  cp "$VOLUME_FILE" "$HOME_FILE"
fi

# Guarantee the welcome/onboarding screen is skipped — even on a brand-fresh
# volume or after Claude rewrites the file minimally. The host's onboarded
# config marks this with hasCompletedOnboarding=true; merge it in idempotently.
[ -s "$HOME_FILE" ] || echo '{}' > "$HOME_FILE"
if command -v jq >/dev/null 2>&1; then
  tmp="$(mktemp)"
  jq '. + {hasCompletedOnboarding: true}' "$HOME_FILE" > "$tmp" && mv "$tmp" "$HOME_FILE"
fi
chmod 600 "$HOME_FILE"

# Seed the volume copy now so the onboarding flag is captured even if the
# container is stopped before the daemon's first poll.
cp "$HOME_FILE" "$VOLUME_FILE"

# Background daemon: keep the volume copy current so the latest login/onboarding
# state is captured before the container stops. setsid detaches from the TTY so
# it survives the launching shell finishing. A 2s poll is plenty.
setsid bash -c '
  while sleep 2; do
    if [ -s "'"$HOME_FILE"'" ] && [ "'"$HOME_FILE"'" -nt "'"$VOLUME_FILE"'" ]; then
      cp "'"$HOME_FILE"'" "'"$VOLUME_FILE"'" 2>/dev/null || true
    fi
  done
' </dev/null >/dev/null 2>&1 &
echo $! > "$DAEMON_PID_FILE"
