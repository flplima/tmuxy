#!/bin/bash
#
# float - Run a command in a floating modal pane
#
# Creates a hidden tmux window that tmuxy UI renders as a centered modal.
# The command runs interactively in the float pane.
#
# Usage:
#   float [options] <command>
#   float top
#   float htop
#   float "vim /tmp/note.txt"
#
# Options:
#   -w WIDTH   Float width in columns (default: 80)
#   -h HEIGHT  Float height in rows (default: 24)
#   -t TITLE   Float window title (default: command name)
#
# Window naming: __float_<title>
# Window options:
#   @float_parent - Parent window ID to return to
#   @float_width  - Requested width in columns
#   @float_height - Requested height in rows

set -e

# Default dimensions
FLOAT_WIDTH=80
FLOAT_HEIGHT=24
FLOAT_TITLE=""

# Parse options
while getopts "w:h:t:" opt; do
  case $opt in
    w) FLOAT_WIDTH="$OPTARG" ;;
    h) FLOAT_HEIGHT="$OPTARG" ;;
    t) FLOAT_TITLE="$OPTARG" ;;
    *) echo "Usage: $0 [-w width] [-h height] [-t title] <command>" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

# Command to run
FLOAT_CMD="$*"
if [ -z "$FLOAT_CMD" ]; then
  echo "Error: No command specified" >&2
  exit 1
fi

# Default title from command
if [ -z "$FLOAT_TITLE" ]; then
  FLOAT_TITLE=$(echo "$FLOAT_CMD" | awk '{print $1}' | xargs basename 2>/dev/null || echo "float")
fi

# Get parent window
PARENT_WINDOW=$(tmux display-message -p '#{window_id}')

# Window name with special prefix (hidden from tmuxy window tabs)
FLOAT_WINDOW_NAME="__float_${FLOAT_TITLE}"

# Find highest window index to place float window at end (like pane group windows)
MAX_INDEX=$(tmux list-windows -F '#{window_index}' | sort -n | tail -1)
FLOAT_INDEX=$((MAX_INDEX + 1))

# Create the float window with the command running interactively
# Use -d to not switch to it (UI will show it as modal overlay)
tmux new-window -d -t ":${FLOAT_INDEX}" -n "$FLOAT_WINDOW_NAME" "$FLOAT_CMD"

# Get the new window ID
FLOAT_WINDOW=$(tmux list-windows -F '#{window_id} #{window_name}' | grep "$FLOAT_WINDOW_NAME" | head -1 | awk '{print $1}')

if [ -z "$FLOAT_WINDOW" ]; then
  echo "Error: Failed to create float window" >&2
  exit 1
fi

# Set window options for tmuxy UI
tmux set-option -wt "$FLOAT_WINDOW" @float_parent "$PARENT_WINDOW"
tmux set-option -wt "$FLOAT_WINDOW" @float_width "$FLOAT_WIDTH"
tmux set-option -wt "$FLOAT_WINDOW" @float_height "$FLOAT_HEIGHT"

# Print the window ID for scripting
echo "$FLOAT_WINDOW"
