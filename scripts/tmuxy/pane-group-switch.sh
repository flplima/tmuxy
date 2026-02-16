#!/bin/bash
# Switch to a target pane within a group
# Args: $1=target_pane_id
#
# Finds the visible pane in the group, resizes the target's window to match,
# then swaps the target into the visible position.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

TARGET_PANE="$1"
ACTIVE_WIN=$(active_window)
GRP_JSON=$(read_groups)

# Find the group containing the target pane
GROUP_ID=$(echo "$GRP_JSON" | jq -r --arg pid "$TARGET_PANE" '
  .groups | to_entries[] | select(.value.paneIds | index($pid)) | .key
' 2>/dev/null | head -1)

if [ -z "$GROUP_ID" ]; then
  exit 0
fi

# Find the visible pane in the active window
VISIBLE_PANE=$(find_visible_pane "$GRP_JSON" "$GROUP_ID" "$ACTIVE_WIN")

if [ -z "$VISIBLE_PANE" ] || [ "$VISIBLE_PANE" = "$TARGET_PANE" ]; then
  exit 0
fi

# Get visible pane dimensions
VISIBLE_WIDTH=$(tmux display-message -t "$VISIBLE_PANE" -p '#{pane_width}')
VISIBLE_HEIGHT=$(tmux display-message -t "$VISIBLE_PANE" -p '#{pane_height}')

# Get target pane's window
TARGET_WIN=$(pane_window "$TARGET_PANE")

# Resize target's window to match visible pane, then swap
tmux resize-window -t "$TARGET_WIN" -x "$VISIBLE_WIDTH" -y "$VISIBLE_HEIGHT" \; \
     swap-pane -s "$TARGET_PANE" -t "$VISIBLE_PANE"

refresh_panes
