#!/bin/bash
# Convert an embedded pane to a float window
# Args: $1=pane_id

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"
PANE_NUM="${PANE_ID#%}"
WINDOW_NAME="__float_${PANE_NUM}"

# Break pane out to its own window
tmux break-pane -d -s "$PANE_ID"

# Rename the window containing this pane to the float pattern
WIN_ID=$(pane_window "$PANE_ID")
tmux rename-window -t "$WIN_ID" "$WINDOW_NAME"

refresh_panes
