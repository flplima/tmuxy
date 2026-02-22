#!/bin/bash
# Create a new float window
# Float windows use index >= 2000 and name pattern __float_temp

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# Find max window index >= 2000
MAX_INDEX=$(tmux list-windows -F '#{window_index}' | awk '$1 >= 2000' | sort -rn | head -1)
NEXT_INDEX=$(( ${MAX_INDEX:-1999} + 1 ))

# Use split-window + break-pane instead of new-window
# (tmux new-window crashes the server when called from run-shell with control mode attached)
NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}')
tmux break-pane -d -s "$NEW_PANE_ID" -n "__float_temp"

refresh_panes
