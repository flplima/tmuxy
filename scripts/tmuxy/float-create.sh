#!/bin/bash
# Create a new float pane
#
# Float-inside-float mode (called from within a __float_* window):
#   Runs the command directly in the current float pane (reuses the same slot).
#
# Interactive mode (no args, not in a float):
#   Creates a float pane with an interactive shell, outputs pane ID to stdout.
#
# Command mode (with args, not in a float):
#   Creates a float pane running the command, captures its stdout,
#   waits for completion, auto-closes the float, and outputs the
#   captured stdout. Enables: FILE=$(tmuxy float fzf) && nvim "$FILE"

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# Detect if we're already inside a float pane
CURRENT_WINDOW=$(tmux display-message -p '#{window_name}')

if [[ "$CURRENT_WINDOW" == __float_* ]]; then
  # Already in a float — reuse the current slot instead of creating a new one
  if [ $# -eq 0 ]; then
    # Interactive mode inside float: replace current shell with a new one
    exec "${SHELL:-bash}"
  else
    # Command mode inside float: run the command directly here, output its result
    "$@"
  fi
  exit $?
fi

if [ $# -eq 0 ]; then
  # Interactive mode: create float with shell, output pane ID
  NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}')
  PANE_NUM="${NEW_PANE_ID#%}"
  tmux break-pane -d -s "$NEW_PANE_ID" -n "__float_${PANE_NUM}"
  refresh_panes
  echo "$NEW_PANE_ID"
else
  # Command mode: run interactive command in float, capture stdout, auto-close
  TMPFILE=$(mktemp /tmp/tmuxy-float-out.XXXXXX)
  WAIT_CHAN="float-done-$$"
  CMD="$*"

  # Do NOT redirect stderr — TUI apps (fzf, vim, etc.) draw their interface to
  # stderr/tty. Only redirect stdout to the capture file.
  NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}' \
    "bash -c '${CMD} > \"${TMPFILE}\"; tmux wait-for -S ${WAIT_CHAN}'")
  PANE_NUM="${NEW_PANE_ID#%}"
  tmux break-pane -d -s "$NEW_PANE_ID" -n "__float_${PANE_NUM}"
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
