#!/bin/bash
# Unified navigation across groups and pane splits (no tab wrap)
# Args: $1=direction (left|right|up|down|next|prev), $2=current pane_id
#
# left/right: group panes (circular) → pane splits (horizontal)
# up/down:    pane splits only (vertical neighbors, no fallback)
# next:       same as right
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

        # Circular wrap within group
        local target_idx
        if [ "$edge_dir" = "right" ]; then
          target_idx=$(( (visible_idx + 1) % pane_count ))
        else
          target_idx=$(( (visible_idx - 1 + pane_count) % pane_count ))
        fi

        if [ "$target_idx" -ne "$visible_idx" ]; then
          idx=0
          for pid in $pane_ids; do
            if [ "$idx" -eq "$target_idx" ]; then
              exec "$SCRIPTS_DIR/pane-group-switch.sh" "$pid"
            fi
            idx=$((idx + 1))
          done
        fi
        return
      fi
    fi
  fi

  # Step 2: Try tmux directional select (no tab fallback)
  tmux selectp "$tmux_dir" 2>/dev/null || true
  refresh_panes
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
