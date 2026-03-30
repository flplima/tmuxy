#!/bin/bash
# Create a new float pane (centered or drawer)
#
# Options:
#   --left|--right|--top|--bottom   Drawer mode (slides from edge)
#   --width N                       Width in columns
#   --height N                      Height in rows
#   --bg dim|blur|none              Backdrop style
#   --hide-header                   Hide the header bar
#
# Float-inside-float mode (called from within a __float_* window):
#   Runs the command directly in the current float pane (reuses the same slot).
#
# Interactive mode (no command args):
#   Creates a float pane with an interactive shell, outputs pane ID to stdout.
#
# Command mode (with args after options):
#   Creates a float pane running the command, captures its stdout,
#   waits for completion, auto-closes the float, and outputs the
#   captured stdout. Enables: FILE=$(tmuxy float fzf) && nvim "$FILE"

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# Parse options
DRAWER=""
WIDTH=""
HEIGHT=""
BG=""
HIDE_HEADER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --left)         DRAWER="left";   shift ;;
    --right)        DRAWER="right";  shift ;;
    --top)          DRAWER="top";    shift ;;
    --bottom)       DRAWER="bottom"; shift ;;
    --width)        WIDTH="$2";      shift 2 ;;
    --height)       HEIGHT="$2";     shift 2 ;;
    --bg)           BG="$2";         shift 2 ;;
    --hide-header)  HIDE_HEADER="1"; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

# Apply default dimensions based on mode
if [ -z "$WIDTH" ] && [ -z "$HEIGHT" ]; then
  case "$DRAWER" in
    left|right)  WIDTH=60 ;;
    top|bottom)  HEIGHT=40 ;;
    *)           WIDTH=60; HEIGHT=40 ;;
  esac
elif [ -z "$WIDTH" ] && [ -n "$DRAWER" ]; then
  case "$DRAWER" in left|right) WIDTH=60 ;; esac
elif [ -z "$HEIGHT" ] && [ -n "$DRAWER" ]; then
  case "$DRAWER" in top|bottom) HEIGHT=40 ;; esac
fi

# Build window name with encoded options
build_float_name() {
  local pane_id="$1"
  local pane_num="${pane_id#%}"
  local name="__float_${pane_num}"
  [ -n "$DRAWER" ]      && name="${name}_drawer_${DRAWER}"
  [ -n "$BG" ]          && name="${name}_bg_${BG}"
  [ -n "$HIDE_HEADER" ] && name="${name}_noheader"
  echo "$name"
}

# Detect if we're already inside a float pane
CURRENT_WINDOW=$(_tmux display-message -p '#{window_name}')

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
  NEW_PANE_ID=$(_tmux split-window -dP -F '#{pane_id}')
  FLOAT_NAME=$(build_float_name "$NEW_PANE_ID")
  _tmux break-pane -d -s "$NEW_PANE_ID" -n "$FLOAT_NAME"

  # Apply size if specified
  if [ -n "$WIDTH" ]; then
    _tmux resize-pane -t "$NEW_PANE_ID" -x "$WIDTH" 2>/dev/null || true
  fi
  if [ -n "$HEIGHT" ]; then
    _tmux resize-pane -t "$NEW_PANE_ID" -y "$HEIGHT" 2>/dev/null || true
  fi

  refresh_panes
  echo "$NEW_PANE_ID"
else
  # Command mode: run interactive command in float, capture stdout, auto-close
  TMPFILE=$(mktemp /tmp/tmuxy-float-out.XXXXXX)
  trap 'rm -f "$TMPFILE"' EXIT
  WAIT_CHAN="float-done-$$"
  CMD="$*"

  # Do NOT redirect stderr — TUI apps (fzf, vim, etc.) draw their interface to
  # stderr/tty. Only redirect stdout to the capture file.
  NEW_PANE_ID=$(_tmux split-window -dP -F '#{pane_id}' \
    "bash -c '${CMD} > \"${TMPFILE}\"; tmux ${TMUX_SOCKET:+-L $TMUX_SOCKET} wait-for -S ${WAIT_CHAN}'")
  FLOAT_NAME=$(build_float_name "$NEW_PANE_ID")
  _tmux break-pane -d -s "$NEW_PANE_ID" -n "$FLOAT_NAME"

  # Apply size if specified
  if [ -n "$WIDTH" ]; then
    _tmux resize-pane -t "$NEW_PANE_ID" -x "$WIDTH" 2>/dev/null || true
  fi
  if [ -n "$HEIGHT" ]; then
    _tmux resize-pane -t "$NEW_PANE_ID" -y "$HEIGHT" 2>/dev/null || true
  fi

  refresh_panes

  # Wait for command to finish
  _tmux wait-for "$WAIT_CHAN"

  # Auto-close the float window
  WIN_ID=$(_tmux display-message -t "$NEW_PANE_ID" -p '#{window_id}' 2>/dev/null || true)
  if [ -n "$WIN_ID" ]; then
    _tmux kill-window -t "$WIN_ID" 2>/dev/null || true
  fi
  refresh_panes

  # Output captured stdout
  cat "$TMPFILE"
fi
