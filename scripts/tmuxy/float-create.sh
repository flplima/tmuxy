#!/bin/bash
# Create a new float pane
#
# Interactive mode (no args):
#   Creates a float pane with an interactive shell, outputs pane ID to stdout.
#
# Command mode (with args):
#   Creates a float pane running the command, captures its stdout,
#   waits for completion, auto-closes the float, and outputs the
#   captured stdout. Enables: FILE=$(tmuxy float fzf) && nvim "$FILE"

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

if [ $# -eq 0 ]; then
  # Interactive mode: create float with shell, output pane ID
  NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}')
  tmux break-pane -d -s "$NEW_PANE_ID" -n "__float_temp"
  refresh_panes
  echo "$NEW_PANE_ID"
else
  # Command mode: run command, capture output, auto-close
  TMPFILE=$(mktemp /tmp/tmuxy-float-out.XXXXXX)
  WAIT_CHAN="float-done-$$"
  CMD="$*"

  NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}' \
    "bash -c '${CMD} > \"${TMPFILE}\" 2>&1; tmux wait-for -S ${WAIT_CHAN}'")
  tmux break-pane -d -s "$NEW_PANE_ID" -n "__float_temp"
  refresh_panes

  # Wait for command to finish
  tmux wait-for "$WAIT_CHAN"

  # Auto-close the float window
  WIN_ID=$(tmux display-message -t "$NEW_PANE_ID" -p '#{window_id}' 2>/dev/null || true)
  if [ -n "$WIN_ID" ]; then
    tmux kill-window -t "$WIN_ID" 2>/dev/null || true
  fi
  refresh_panes

  # Output captured stdout
  cat "$TMPFILE"
  rm -f "$TMPFILE"
fi
