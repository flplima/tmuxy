#!/bin/bash
# Switch to a target pane within a group
# Args: $1=target_pane_id
#
# Finds the visible pane in the group, resizes the target's window to match,
# then swaps the target into the visible position.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

TARGET_PANE="$1"

# Find the group containing the target pane
GROUP_NAME=$(find_group_for_pane "$TARGET_PANE")

if [ -z "$GROUP_NAME" ]; then
  exit 0
fi

# Parse pane list and find visible pane
PANE_IDS=$(parse_group_panes "$GROUP_NAME")
# shellcheck disable=SC2086
VISIBLE_PANE=$(find_visible_pane_from_list $PANE_IDS)

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
