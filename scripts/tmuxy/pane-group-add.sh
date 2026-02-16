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

GRP_JSON=$(read_groups)
GRP_JSON=$(clean_stale_groups "$GRP_JSON")

# Find existing group for this pane
EXISTING_GROUP_ID=$(echo "$GRP_JSON" | jq -r --arg pid "$PANE_ID" '
  .groups | to_entries[] | select(.value.paneIds | index($pid)) | .key
' 2>/dev/null | head -1)

if [ -n "$EXISTING_GROUP_ID" ]; then
  GROUP_ID="$EXISTING_GROUP_ID"
  NEXT_INDEX=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" '.groups[$gid].paneIds | length')
else
  GROUP_ID=$(gen_group_id)
  NEXT_INDEX=1
fi

# Compute window name and index
WINDOW_NAME="__group_${GROUP_ID}_${NEXT_INDEX}"
GROUP_HASH=$(hash_string "$GROUP_ID")
WINDOW_INDEX=$(( 1000 + (GROUP_HASH % 1000) * 10 + NEXT_INDEX ))

# Create new window, retrying with offset if index is in use
NEW_PANE_ID=""
for attempt in 0 1 2 3 4; do
  IDX=$(( WINDOW_INDEX + attempt * 100 ))
  NEW_PANE_ID=$(tmux new-window -dP -F '#{pane_id}' -t ":${IDX}" -n "$WINDOW_NAME" 2>/dev/null) && break || true
done

if [ -z "$NEW_PANE_ID" ]; then
  # Fallback: let tmux pick the index
  NEW_PANE_ID=$(tmux new-window -dP -F '#{pane_id}' -n "$WINDOW_NAME")
  IDX=$(tmux display-message -t "$NEW_PANE_ID" -p '#{window_index}')
fi

# Resize the new window to match the source pane
tmux resize-window -t "$NEW_PANE_ID" -x "$PANE_WIDTH" -y "$PANE_HEIGHT"

# Update TMUXY_GROUPS
if [ -n "$EXISTING_GROUP_ID" ]; then
  # Add new pane to existing group
  GRP_JSON=$(echo "$GRP_JSON" | jq -c --arg gid "$GROUP_ID" --arg pid "$NEW_PANE_ID" '
    .groups[$gid].paneIds += [$pid]
  ')
else
  # Create new group with active pane + new pane
  GRP_JSON=$(echo "$GRP_JSON" | jq -c --arg gid "$GROUP_ID" --arg pid1 "$PANE_ID" --arg pid2 "$NEW_PANE_ID" '
    .groups[$gid] = { id: $gid, paneIds: [$pid1, $pid2] }
  ')
fi

save_groups "$GRP_JSON"

# Auto-switch: swap new pane into visible position
tmux swap-pane -s "$NEW_PANE_ID" -t "$PANE_ID"

refresh_panes
