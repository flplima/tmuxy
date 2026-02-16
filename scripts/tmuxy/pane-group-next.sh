#!/bin/bash
# Navigate to the next tab in a pane group
# Args: $1=active_pane_id

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"
ACTIVE_WIN=$(active_window)
GRP_JSON=$(read_groups)

# Find the group containing this pane
GROUP_ID=$(echo "$GRP_JSON" | jq -r --arg pid "$PANE_ID" '
  .groups | to_entries[] | select(.value.paneIds | index($pid)) | .key
' 2>/dev/null | head -1)

if [ -z "$GROUP_ID" ]; then
  exit 0
fi

PANE_IDS=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" '.groups[$gid].paneIds[]')
PANE_COUNT=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" '.groups[$gid].paneIds | length')

if [ "$PANE_COUNT" -le 1 ]; then
  exit 0
fi

# Find visible pane in active window
VISIBLE_PANE=$(find_visible_pane "$GRP_JSON" "$GROUP_ID" "$ACTIVE_WIN")
if [ -z "$VISIBLE_PANE" ]; then
  exit 0
fi

# Find index of visible pane and compute next
IDX=0
VISIBLE_IDX=0
for pid in $PANE_IDS; do
  if [ "$pid" = "$VISIBLE_PANE" ]; then
    VISIBLE_IDX=$IDX
  fi
  IDX=$((IDX + 1))
done

LAST_IDX=$((PANE_COUNT - 1))
if [ "$VISIBLE_IDX" -lt "$LAST_IDX" ]; then
  NEXT_IDX=$((VISIBLE_IDX + 1))
else
  NEXT_IDX=0
fi

TARGET=$(echo "$GRP_JSON" | jq -r --arg gid "$GROUP_ID" --argjson idx "$NEXT_IDX" '.groups[$gid].paneIds[$idx]')

if [ "$TARGET" != "$VISIBLE_PANE" ]; then
  exec "$SCRIPTS_DIR/pane-group-switch.sh" "$TARGET"
fi
