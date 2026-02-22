#!/bin/bash
# Navigate to the next tab in a pane group
# Args: $1=active_pane_id

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

PANE_ID="$1"

# Find the group containing this pane
GROUP_NAME=$(find_group_for_pane "$PANE_ID")

if [ -z "$GROUP_NAME" ]; then
  exit 0
fi

PANE_IDS=$(parse_group_panes "$GROUP_NAME")
# shellcheck disable=SC2086
set -- $PANE_IDS
PANE_COUNT=$#

if [ "$PANE_COUNT" -le 1 ]; then
  exit 0
fi

# Find visible pane in active window
# shellcheck disable=SC2086
VISIBLE_PANE=$(find_visible_pane_from_list $PANE_IDS)
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

# Get target pane ID
IDX=0
TARGET=""
for pid in $PANE_IDS; do
  if [ "$IDX" -eq "$NEXT_IDX" ]; then
    TARGET="$pid"
    break
  fi
  IDX=$((IDX + 1))
done

if [ -n "$TARGET" ] && [ "$TARGET" != "$VISIBLE_PANE" ]; then
  exec "$SCRIPTS_DIR/pane-group-switch.sh" "$TARGET"
fi
