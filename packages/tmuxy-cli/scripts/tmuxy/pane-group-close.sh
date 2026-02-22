#!/bin/bash
# Close a pane from a group
# Args: $1=pane_id_to_close
#
# If the pane is visible and others exist, swaps next pane in before killing.
# If the pane is in a hidden group window, kills that window.
# Renames remaining group windows to exclude the closed pane.

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

CLOSE_PANE="$1"
ACTIVE_WIN=$(active_window)

# Find the group containing this pane
GROUP_NAME=$(find_group_for_pane "$CLOSE_PANE")

# Not in a group - just kill the pane
if [ -z "$GROUP_NAME" ]; then
  tmux kill-pane -t "$CLOSE_PANE"
  refresh_panes
  exit 0
fi

# Parse pane list from group name
PANE_IDS=$(parse_group_panes "$GROUP_NAME")
# shellcheck disable=SC2086
set -- $PANE_IDS
PANE_COUNT=$#

# Find visible pane
# shellcheck disable=SC2086
VISIBLE_PANE=$(find_visible_pane_from_list $PANE_IDS)
IS_VISIBLE=false
if [ "$VISIBLE_PANE" = "$CLOSE_PANE" ]; then
  IS_VISIBLE=true
fi

# Get the window of the pane being closed
CLOSE_WIN=$(pane_window "$CLOSE_PANE")

if [ "$IS_VISIBLE" = true ] && [ "$PANE_COUNT" -gt 1 ]; then
  # Closing the visible pane - swap another in first
  # Find index of closing pane in the list
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

  # Get next pane ID from the list
  IDX=0
  NEXT_PANE=""
  for pid in $PANE_IDS; do
    if [ "$IDX" -eq "$NEXT_IDX" ]; then
      NEXT_PANE="$pid"
      break
    fi
    IDX=$((IDX + 1))
  done

  NEXT_WIN=$(pane_window "$NEXT_PANE")

  # Swap the next pane into view, then kill the window that now holds the closing pane
  tmux swap-pane -s "$CLOSE_PANE" -t "$NEXT_PANE" \; kill-window -t "$NEXT_WIN"
elif [ "$CLOSE_WIN" != "$ACTIVE_WIN" ]; then
  # Pane is in a hidden group window - kill the window
  tmux kill-window -t "$CLOSE_WIN"
else
  # Pane is in the active window (last in group) - kill pane
  tmux kill-pane -t "$CLOSE_PANE"
fi

# Build remaining pane list (excluding closed pane)
REMAINING=""
for pid in $PANE_IDS; do
  if [ "$pid" != "$CLOSE_PANE" ]; then
    if [ -n "$REMAINING" ]; then
      REMAINING="$REMAINING $pid"
    else
      REMAINING="$pid"
    fi
  fi
done

# shellcheck disable=SC2086
set -- $REMAINING
REMAINING_COUNT=$#

if [ "$REMAINING_COUNT" -ge 2 ]; then
  # Rename remaining group windows to exclude the closed pane
  # shellcheck disable=SC2086
  NEW_GROUP_NAME=$(build_group_name $REMAINING)
  rename_group_windows "$GROUP_NAME" "$NEW_GROUP_NAME"
fi
# If <2 panes remain, the group window was already killed above — no rename needed

refresh_panes
