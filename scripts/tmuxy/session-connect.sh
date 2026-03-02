#!/bin/bash
# session-connect.sh — SSH connection prompt (Tauri desktop app only)
#
# Creates a new tmux session running an SSH command and sets
# TMUXY_SWITCH_TO for the frontend to pick up.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --web)
      echo "SSH connections are only available in the Tauri desktop app."
      exit 1
      ;;
    --help|-h)
      echo "Usage: tmuxy session connect [--web]"
      echo ""
      echo "Prompt for an SSH command and create a session for it."
      echo "  --web   Print not-supported message and exit (used by web frontend)"
      exit 0
      ;;
  esac
done

read -rp 'Enter SSH command (e.g., ssh user@host), or blank for localhost: ' ssh_cmd

if [ -z "$ssh_cmd" ]; then
  echo "Already connected to localhost."
  exit 0
fi

# Extract host for session name (strip user@ prefix, take first word)
host=$(echo "$ssh_cmd" | awk '{print $NF}' | sed 's/.*@//')
session_name="ssh_${host}"

# Create session running the SSH command
tmux new-session -d -s "$session_name" "$ssh_cmd"
echo "$session_name"
tmux set-environment -g TMUXY_SWITCH_TO "$session_name"
