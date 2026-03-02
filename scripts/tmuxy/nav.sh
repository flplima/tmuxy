#!/bin/bash
# Unified navigation across groups, pane splits, and tabs
# Args: $1=direction (left|right|up|down|next|prev), $2=current pane_id
#
# left/right: group panes → pane splits (horizontal) → tabs (circular wrap)
# up/down:    pane splits only (vertical neighbors, no fallback)
# next:       same as right (sequential forward through hierarchy)
# prev:       last-pane in window, fall back to last-window

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

DIR="$1"
PANE_ID="$2"

nav_prev() {
  # Try last-pane (switches to last active pane in current window)
  local before after
  before=$(tmux display-message -p '#{pane_id}')
  tmux last-pane 2>/dev/null || true
  after=$(tmux display-message -p '#{pane_id}')
  if [ "$before" != "$after" ]; then
    refresh_panes
    return
  fi
  # Only 1 pane — try last-window
  tmux last-window 2>/dev/null || true
  refresh_panes
}

nav_vertical() {
  local tmux_dir="$1"
  tmux selectp "$tmux_dir"
  refresh_panes
}

nav_horizontal() {
  local tmux_dir="$1"   # -R or -L
  local edge_dir="$2"   # "right" or "left"

  # Step 1: Check if pane is in a group
  local group_name
  group_name=$(find_group_for_pane "$PANE_ID")

  if [ -n "$group_name" ]; then
    local pane_ids
    pane_ids=$(parse_group_panes "$group_name")
    # shellcheck disable=SC2086
    set -- $pane_ids
    local pane_count=$#

    if [ "$pane_count" -gt 1 ]; then
      # Find visible pane in active window
      # shellcheck disable=SC2086
      local visible_pane
      visible_pane=$(find_visible_pane_from_list $pane_ids)

      if [ -n "$visible_pane" ]; then
        # Find index of visible pane
        local idx=0 visible_idx=0
        for pid in $pane_ids; do
          if [ "$pid" = "$visible_pane" ]; then
            visible_idx=$idx
          fi
          idx=$((idx + 1))
        done

        local last_idx=$((pane_count - 1))
        local at_edge=false

        if [ "$edge_dir" = "right" ] && [ "$visible_idx" -lt "$last_idx" ]; then
          # Can move right within group
          local next_idx=$((visible_idx + 1))
          idx=0
          for pid in $pane_ids; do
            if [ "$idx" -eq "$next_idx" ]; then
              exec "$SCRIPTS_DIR/pane-group-switch.sh" "$pid"
            fi
            idx=$((idx + 1))
          done
        elif [ "$edge_dir" = "left" ] && [ "$visible_idx" -gt 0 ]; then
          # Can move left within group
          local prev_idx=$((visible_idx - 1))
          idx=0
          for pid in $pane_ids; do
            if [ "$idx" -eq "$prev_idx" ]; then
              exec "$SCRIPTS_DIR/pane-group-switch.sh" "$pid"
            fi
            idx=$((idx + 1))
          done
        else
          at_edge=true
        fi

        if ! $at_edge; then
          return
        fi
      fi
    fi
  fi

  # Step 2: Try tmux directional select
  local before after
  before=$(tmux display-message -p '#{pane_id}')
  tmux selectp "$tmux_dir" 2>/dev/null || true
  after=$(tmux display-message -p '#{pane_id}')

  if [ "$before" != "$after" ]; then
    refresh_panes
    return
  fi

  # Step 3: Navigate to next/prev visible tab (skip __group_* windows)
  local windows
  windows=$(list_visible_windows)
  local win_count
  win_count=$(echo "$windows" | wc -l)

  if [ "$win_count" -le 1 ]; then
    return
  fi

  local current_win
  current_win=$(tmux display-message -p '#{window_id}')

  local win_idx=0 current_idx=0
  while IFS= read -r wid; do
    if [ "$wid" = "$current_win" ]; then
      current_idx=$win_idx
    fi
    win_idx=$((win_idx + 1))
  done <<< "$windows"

  local target_idx
  if [ "$edge_dir" = "right" ]; then
    target_idx=$(( (current_idx + 1) % win_count ))
  else
    target_idx=$(( (current_idx - 1 + win_count) % win_count ))
  fi

  local idx=0
  while IFS= read -r wid; do
    if [ "$idx" -eq "$target_idx" ]; then
      tmux select-window -t "$wid"
      refresh_panes
      return
    fi
    idx=$((idx + 1))
  done <<< "$windows"
}

case "$DIR" in
  left)
    nav_horizontal "-L" "left"
    ;;
  right|next)
    nav_horizontal "-R" "right"
    ;;
  up)
    nav_vertical "-U"
    ;;
  down)
    nav_vertical "-D"
    ;;
  prev)
    nav_prev
    ;;
esac
