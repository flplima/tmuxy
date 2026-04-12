#!/bin/bash
# Shared helpers for tmuxy shell scripts
# Window name format: __group_{paneNum1}-{paneNum2}-{paneNum3}
# Groups are derived entirely from window names — no env var needed.

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Derive TMUX_SOCKET from TMUX env var if not already set.
# Inside run-shell, TMUX is e.g. "/tmp/tmux-1000/tmuxy-dev,110,9" — extract
# the socket name (basename of the path before the first comma).
if [ -z "${TMUX_SOCKET:-}" ] && [ -n "${TMUX:-}" ]; then
  _path="${TMUX%%,*}"
  TMUX_SOCKET="$(basename "$_path")"
  export TMUX_SOCKET
fi

# Wrap tmux to respect TMUX_SOCKET env var for named server sockets.
# Using -L bypasses the TMUX env var, which returns corrupted list-windows
# results inside run-shell (tmux 3.5a bug).
_tmux() {
  command tmux ${TMUX_SOCKET:+-L "$TMUX_SOCKET"} "$@"
}

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

  _tmux list-windows -F '#{window_name}' | while read -r wname; do
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

# Find which pane from a list is in a visible (non-group, non-float) window.
# The tmux "active" window can itself be a group window after a swap-pane,
# so we check against all visible windows rather than just the active one.
# Args: paneId1 paneId2 ...
# Output: the pane ID in a visible window, or empty string
find_visible_pane_from_list() {
  local visible_wins
  visible_wins=$(_tmux list-windows -F '#{window_id} #{window_name}' | while read -r wid wname; do
    if [[ "$wname" != __group_* ]] && [[ "$wname" != __float_* ]]; then
      echo "$wid"
    fi
  done)
  local pane_list
  pane_list=$(_tmux list-panes -s -F '#{pane_id},#{window_id}')

  for pid in "$@"; do
    local win_id
    win_id=$(echo "$pane_list" | grep "^${pid}," | cut -d',' -f2)
    if echo "$visible_wins" | grep -qx "$win_id"; then
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
  _tmux list-windows -F '#{window_id} #{window_name}' | while read -r wid wname; do
    if [ "$wname" = "$old_name" ]; then
      _tmux rename-window -t "$wid" "$new_name"
    fi
  done
}

# Get active window ID
active_window() {
  _tmux display-message -p '#{window_id}'
}

# Get a pane's window ID
pane_window() {
  _tmux display-message -t "$1" -p '#{window_id}'
}

# List visible (non-group) window IDs, one per line
list_visible_windows() {
  _tmux list-windows -F '#{window_id} #{window_name}' | while read -r wid wname; do
    if [[ "$wname" != __group_* ]]; then
      echo "$wid"
    fi
  done
}

# Force a list-panes refresh (so server pushes new state to clients)
refresh_panes() {
  _tmux list-panes -s -F '#{pane_id},#{pane_index},#{pane_left},#{pane_top},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{pane_active},#{pane_current_command},#{pane_title},#{pane_in_mode},#{copy_cursor_x},#{copy_cursor_y},#{window_id}' > /dev/null 2>&1
}
