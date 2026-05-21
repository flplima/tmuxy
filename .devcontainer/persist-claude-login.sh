#!/usr/bin/env bash
# Persist ~/.claude.json (onboarding flag, oauthAccount, MCP/trust settings) into
# the ~/.claude/ named volume so Claude Code's welcome screen doesn't re-appear
# after a container restart.
#
# Why the previous symlink approach failed:
#   Claude Code writes ~/.claude.json atomically (write tmpfile + rename). The
#   rename REPLACES the symlink with a regular file in $HOME, which lives in
#   the container's writable layer and gets wiped on container recreation.
#
# Strategy here:
#   1. On start, restore ~/.claude.json from the volume copy.
#   2. Run a background polling daemon that copies ~/.claude.json → volume
#      whenever the home-dir file is newer. 2s poll is fine — onboarding
#      state changes rarely, and we just need the latest copy in the volume
#      before the user stops the container.
#
# Must be idempotent and safe to re-run on every container start.
set -euo pipefail

HOME_FILE=/home/user/.claude.json
VOLUME_FILE=/home/user/.claude/.claude.json
DAEMON_PID_FILE=/home/user/.claude/.persist-daemon.pid

# Stop any prior daemon from a previous container generation. The PID file
# lives in the volume, so it survives restarts; the actual process does not,
# so the kill will usually fail benignly.
if [ -f "$DAEMON_PID_FILE" ]; then
  kill "$(cat "$DAEMON_PID_FILE")" 2>/dev/null || true
  rm -f "$DAEMON_PID_FILE"
fi

# Decide which copy is canonical. The newer one wins:
#   - On fresh container start: writable layer is empty → no $HOME_FILE (or an
#     empty default) → volume copy is newer → restore volume → home.
#   - When this script runs mid-session (e.g. previous daemon already synced
#     state up to the volume but the user has since made changes): home file
#     is newer → copy up so we don't clobber recent state.
#   - First run on a fresh volume: only $HOME_FILE exists → seed the volume.
if [ -s "$HOME_FILE" ] && [ "$HOME_FILE" -nt "$VOLUME_FILE" ]; then
  cp "$HOME_FILE" "$VOLUME_FILE"
elif [ -s "$VOLUME_FILE" ]; then
  cp "$VOLUME_FILE" "$HOME_FILE"
  chmod 600 "$HOME_FILE"
fi

# Start the background sync daemon. setsid detaches from the current TTY so
# it survives the postStartCommand finishing.
setsid bash -c '
  while sleep 2; do
    if [ -s "'"$HOME_FILE"'" ] && [ "'"$HOME_FILE"'" -nt "'"$VOLUME_FILE"'" ]; then
      cp "'"$HOME_FILE"'" "'"$VOLUME_FILE"'" 2>/dev/null || true
    fi
  done
' </dev/null >/dev/null 2>&1 &
echo $! > "$DAEMON_PID_FILE"
