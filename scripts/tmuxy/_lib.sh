#!/bin/bash
# Shared helpers for tmuxy shell scripts
# Provides functions for reading/saving pane group state from tmux environment

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Read TMUXY_GROUPS from session environment
# Returns JSON string or default empty structure
read_groups() {
  local raw
  raw=$(tmux show-environment TMUXY_GROUPS 2>/dev/null)
  if [ $? -ne 0 ] || [ -z "$raw" ] || [ "${raw:0:1}" = "-" ]; then
    echo '{"version":1,"groups":{}}'
  else
    echo "${raw#*=}"
  fi
}

# Save TMUXY_GROUPS to session environment
save_groups() {
  tmux set-environment TMUXY_GROUPS "$1"
}

# Generate a random group ID (g_ + 8 hex chars)
gen_group_id() {
  printf "g_%s" "$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
}

# Get active window ID
active_window() {
  tmux display-message -p '#{window_id}'
}

# Get a pane's window ID
pane_window() {
  tmux display-message -t "$1" -p '#{window_id}'
}

# Hash a string to a number (for computing window indices)
hash_string() {
  local sum=0
  local i
  for (( i=0; i<${#1}; i++ )); do
    sum=$(( sum + $(printf '%d' "'${1:$i:1}") ))
  done
  echo $sum
}

# Find the visible pane from a group in the active window
# Args: $1=groups_json $2=group_id $3=active_window_id
# Prints the visible pane ID or empty string
find_visible_pane() {
  local grp_json="$1"
  local group_id="$2"
  local active_win="$3"

  local pane_ids
  pane_ids=$(echo "$grp_json" | jq -r ".groups[\"$group_id\"].paneIds[]" 2>/dev/null)

  # Get all panes in the session with their window IDs
  local pane_list
  pane_list=$(tmux list-panes -s -F '#{pane_id},#{window_id}')

  for pid in $pane_ids; do
    local win_id
    win_id=$(echo "$pane_list" | grep "^${pid}," | cut -d',' -f2)
    if [ "$win_id" = "$active_win" ]; then
      echo "$pid"
      return
    fi
  done
  echo ""
}

# Force a list-panes refresh (so server pushes new state to clients)
refresh_panes() {
  tmux list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}' > /dev/null 2>&1
}
