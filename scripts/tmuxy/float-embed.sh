#!/bin/bash
# Join a float pane back into the active window
# Args: $1=pane_id

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"
ACTIVE_WIN=$(active_window)

tmux join-pane -s "$PANE_ID" -t "$ACTIVE_WIN"

refresh_panes
