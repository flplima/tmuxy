#!/bin/bash
# Shared helpers for tmuxy shell scripts
# Window name format: __group_{paneNum1}-{paneNum2}-{paneNum3}
# Groups are derived entirely from window names — no env var needed.

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build a group window name from a list of pane IDs
# Args: paneId1 paneId2 ...
# Output: __group_4-6-7 (strips % prefix, joins with -)
build_group_name() {
  local parts=""
  for pid in "$@"; do
    local num="${pid#%}"
    if [ -n "$parts" ]; then
      parts="${parts}-${num}"
    else
      parts="$num"
    fi
  done
  echo "__group_${parts}"
}

# Find the group window name containing a pane
# Args: $1=paneId (e.g., %4)
# Output: window name (e.g., __group_4-6-7) or empty string
find_group_for_pane() {
  local pane_id="$1"
  local pane_num="${pane_id#%}"

  tmux list-windows -F '#{window_name}' | while read -r wname; do
    if [[ "$wname" != __group_* ]]; then
      continue
    fi
    local rest="${wname#__group_}"
    # Check if pane_num appears in the dash-separated list
    local IFS='-'
    for num in $rest; do
      if [ "$num" = "$pane_num" ]; then
        echo "$wname"
        return
      fi
    done
  done
}

# Parse pane IDs from a group window name
# Args: $1=window_name (e.g., __group_4-6-7)
# Output: space-separated pane IDs (e.g., %4 %6 %7)
parse_group_panes() {
  local wname="$1"
  local rest="${wname#__group_}"
  local IFS='-'
  local result=""
  for num in $rest; do
    if [ -n "$result" ]; then
      result="$result %${num}"
    else
      result="%${num}"
    fi
  done
  echo "$result"
}

# Find which pane from a list is in the active window
# Args: paneId1 paneId2 ...
# Output: the pane ID in the active window, or empty string
find_visible_pane_from_list() {
  local active_win
  active_win=$(tmux display-message -p '#{window_id}')
  local pane_list
  pane_list=$(tmux list-panes -s -F '#{pane_id},#{window_id}')

  for pid in "$@"; do
    local win_id
    win_id=$(echo "$pane_list" | grep "^${pid}," | cut -d',' -f2)
    if [ "$win_id" = "$active_win" ]; then
      echo "$pid"
      return
    fi
  done
  echo ""
}

# Rename all windows with a given name to a new name
# Args: $1=old_name $2=new_name
rename_group_windows() {
  local old_name="$1"
  local new_name="$2"
  tmux list-windows -F '#{window_id} #{window_name}' | while read -r wid wname; do
    if [ "$wname" = "$old_name" ]; then
      tmux rename-window -t "$wid" "$new_name"
    fi
  done
}

# Get active window ID
active_window() {
  tmux display-message -p '#{window_id}'
}

# Get a pane's window ID
pane_window() {
  tmux display-message -t "$1" -p '#{window_id}'
}

# Force a list-panes refresh (so server pushes new state to clients)
refresh_panes() {
  tmux list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}' > /dev/null 2>&1
}
