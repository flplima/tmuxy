#!/bin/bash
# tmuxy pane find — discover panes by metadata
#
# Usage:
#   tmuxy pane find role=worker              Find panes matching key=value
#   tmuxy pane find role=worker state=idle   Multiple predicates (AND)
#   tmuxy pane find --first role=worker      First match only
#   tmuxy pane find --json role=worker       JSON output with full metadata
#   tmuxy pane find --wait=3000 role=worker  Poll until match or timeout
#   tmuxy pane find --all                    All panes with any tmuxy metadata

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# Parse flags
FIRST=false
JSON=false
WAIT_MS=0
ALL=false
PREDICATES=()

for arg in "$@"; do
  case "$arg" in
    --first) FIRST=true ;;
    --json) JSON=true ;;
    --wait=*) WAIT_MS="${arg#--wait=}" ;;
    --all) ALL=true ;;
    *=*) PREDICATES+=("$arg") ;;
  esac
done

if [ ${#PREDICATES[@]} -eq 0 ] && ! $ALL; then
  echo "Error: at least one key=value predicate or --all required" >&2
  exit 1
fi

# Find matching panes. Returns space-separated pane IDs.
find_matches() {
  if $ALL; then
    # Find all panes with any @tmuxy_ctx_* option
    _tmux list-panes -s -F '#{pane_id}' | while read -r pid; do
      local meta
      meta=$(_tmux show-options -p -t "$pid" 2>/dev/null | grep -c '^@tmuxy_ctx_' || true)
      if [ "$meta" -gt 0 ]; then
        echo "$pid"
      fi
    done
    return
  fi

  # Build format string with the keys we need
  local keys=()
  local vals=()
  for pred in "${PREDICATES[@]}"; do
    keys+=("${pred%%=*}")
    vals+=("${pred#*=}")
  done

  # Use list-panes with format variables for fast filtering
  local fmt='#{pane_id}'
  for key in "${keys[@]}"; do
    fmt="${fmt},#{@tmuxy_ctx_${key}}"
  done

  _tmux list-panes -s -F "$fmt" | while IFS=',' read -r pid rest; do
    # Split rest into values
    local i=0
    local match=true
    local IFS=','
    local actual_vals=($rest)
    for expected in "${vals[@]}"; do
      if [ "${actual_vals[$i]:-}" != "$expected" ]; then
        match=false
        break
      fi
      ((i++))
    done
    if $match; then
      echo "$pid"
    fi
  done
}

# Output results in requested format
output_results() {
  local panes=("$@")
  if [ ${#panes[@]} -eq 0 ]; then
    if $JSON; then echo "[]"; fi
    return 1
  fi

  if $JSON; then
    local sep=""
    printf "["
    for pid in "${panes[@]}"; do
      local meta
      meta=$(get_all_pane_meta "$pid")
      local meta_json
      if [ -n "$meta" ]; then
        meta_json=$(echo "$meta" | meta_to_json)
      else
        meta_json="{}"
      fi
      local cmd
      cmd=$(_tmux display-message -t "$pid" -p '#{pane_current_command}' 2>/dev/null || echo "")
      printf '%s{"id":"%s","command":"%s","meta":%s}' "$sep" "$pid" "$cmd" "$meta_json"
      sep=","
    done
    printf "]\n"
  else
    echo "${panes[*]}"
  fi
}

# Single-shot or poll
if [ "$WAIT_MS" -eq 0 ]; then
  mapfile -t matches < <(find_matches)
  if $FIRST && [ ${#matches[@]} -gt 0 ]; then
    matches=("${matches[0]}")
  fi
  output_results "${matches[@]}"
else
  # Poll loop
  local_elapsed=0
  while [ "$local_elapsed" -lt "$WAIT_MS" ]; do
    mapfile -t matches < <(find_matches)
    if $FIRST && [ ${#matches[@]} -gt 0 ]; then
      matches=("${matches[0]}")
    fi
    if [ ${#matches[@]} -gt 0 ]; then
      output_results "${matches[@]}"
      exit 0
    fi
    sleep 0.25
    local_elapsed=$((local_elapsed + 250))
  done
  # Timeout
  if $JSON; then echo "[]"; fi
  exit 1
fi
