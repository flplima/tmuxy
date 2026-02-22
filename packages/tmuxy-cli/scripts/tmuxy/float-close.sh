#!/bin/bash
# Close a float window by pane ID
# Args: $1=pane_id

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"

# Get the window containing this pane and kill it
WIN_ID=$(pane_window "$PANE_ID")

if [ -n "$WIN_ID" ]; then
  tmux kill-window -t "$WIN_ID"
fi

refresh_panes
