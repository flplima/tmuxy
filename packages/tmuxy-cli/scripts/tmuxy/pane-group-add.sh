#!/bin/bash
# Create a new pane in a group
# Args: $1=pane_id $2=pane_width $3=pane_height
#
# If the active pane is already in a group, adds to that group.
# Otherwise creates a new group with the active pane + new pane.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"
PANE_WIDTH="$2"
PANE_HEIGHT="$3"

# Check if active pane is already in a group
EXISTING_GROUP=$(find_group_for_pane "$PANE_ID")

# Create new pane via split-window + break-pane
# (tmux new-window crashes the server when called from run-shell with control mode attached)
NEW_PANE_ID=$(tmux split-window -dP -F '#{pane_id}')

if [ -n "$EXISTING_GROUP" ]; then
  # Add to existing group: parse current panes, append new one, rename all windows
  CURRENT_PANES=$(parse_group_panes "$EXISTING_GROUP")
  # shellcheck disable=SC2086
  NEW_GROUP_NAME=$(build_group_name $CURRENT_PANES "$NEW_PANE_ID")
  tmux break-pane -d -s "$NEW_PANE_ID" -n "$NEW_GROUP_NAME"
  rename_group_windows "$EXISTING_GROUP" "$NEW_GROUP_NAME"
else
  # New group with active pane + new pane
  GROUP_NAME=$(build_group_name "$PANE_ID" "$NEW_PANE_ID")
  tmux break-pane -d -s "$NEW_PANE_ID" -n "$GROUP_NAME"
fi

# Resize the new window to match the source pane
tmux resize-window -t "$NEW_PANE_ID" -x "$PANE_WIDTH" -y "$PANE_HEIGHT"

# Auto-switch: swap new pane into visible position
tmux swap-pane -s "$NEW_PANE_ID" -t "$PANE_ID"

refresh_panes
