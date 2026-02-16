#!/bin/bash
# Close a pane from a group
# Args: $1=pane_id_to_close
#
# If the pane is visible and others exist, swaps next pane in before killing.
# If the pane is in a hidden group window, kills that window.
# Updates TMUXY_GROUPS to remove the pane and clean up empty groups.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

CLOSE_PANE="$1"
ACTIVE_WIN=$(active_window)
GRP_JSON=$(read_groups)

# Find the group containing this pane
GROUP_ID=$(echo "$GRP_JSON" | jq -r --arg pid "$CLOSE_PANE" '
  .groups | to_entries[] | select(.value.paneIds | index($pid)) | .key
' 2>/dev/null | head -1)

# Not in a group - just kill the pane
if [ -z "$GROUP_ID" ]; then
  tmux kill-pane -t "$CLOSE_PANE"
  refresh_panes
  exit 0
fi

PANE_COUNT=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" '.groups[$gid].paneIds | length')

# Find visible pane
VISIBLE_PANE=$(find_visible_pane "$GRP_JSON" "$GROUP_ID" "$ACTIVE_WIN")
IS_VISIBLE=false
if [ "$VISIBLE_PANE" = "$CLOSE_PANE" ]; then
  IS_VISIBLE=true
fi

# Get the window of the pane being closed
CLOSE_WIN=$(pane_window "$CLOSE_PANE")

if [ "$IS_VISIBLE" = true ] && [ "$PANE_COUNT" -gt 1 ]; then
  # Closing the visible pane - need to swap another in first
  PANE_IDS=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" '.groups[$gid].paneIds[]')

  # Find index of closing pane
  IDX=0
  CLOSE_IDX=0
  for pid in $PANE_IDS; do
    if [ "$pid" = "$CLOSE_PANE" ]; then
      CLOSE_IDX=$IDX
    fi
    IDX=$((IDX + 1))
  done

  # Pick next (or previous if at end)
  LAST_IDX=$((PANE_COUNT - 1))
  if [ "$CLOSE_IDX" -lt "$LAST_IDX" ]; then
    NEXT_IDX=$((CLOSE_IDX + 1))
  else
    NEXT_IDX=$((CLOSE_IDX - 1))
  fi

  NEXT_PANE=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" --argjson idx "$NEXT_IDX" '.groups[$gid].paneIds[$idx]')
  NEXT_WIN=$(pane_window "$NEXT_PANE")

  # Swap the next pane into view, then kill the window that now holds the closing pane
  tmux swap-pane -s "$CLOSE_PANE" -t "$NEXT_PANE" \; kill-window -t "$NEXT_WIN"
elif [ "$CLOSE_WIN" != "$ACTIVE_WIN" ]; then
  # Pane is in a hidden group window - kill the window
  tmux kill-window -t "$CLOSE_WIN"
else
  # Pane is in the active window (last in group or not grouped there) - kill pane
  tmux kill-pane -t "$CLOSE_PANE"
fi

# Update TMUXY_GROUPS: remove pane, clean up group if < 2 panes
GRP_JSON=$(echo "$GRP_JSON" | jq -c --arg gid "$GROUP_ID" --arg pid "$CLOSE_PANE" '
  .groups[$gid].paneIds -= [$pid] |
  if (.groups[$gid].paneIds | length) < 2 then
    del(.groups[$gid])
  else
    .
  end
')

save_groups "$GRP_JSON"
refresh_panes
