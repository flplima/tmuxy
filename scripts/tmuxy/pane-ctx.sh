#!/bin/bash
# tmuxy pane ctx — get/set/list pane metadata
#
# Usage:
#   tmuxy pane ctx                        List all metadata
#   tmuxy pane ctx --json                 List all metadata as JSON
#   tmuxy pane ctx key                    Get a key
#   tmuxy pane ctx key=value              Set a key
#   tmuxy pane ctx key=                   Delete a key
#   tmuxy pane ctx -t %5 key=value        Target a specific pane
#   tmuxy pane ctx role=worker state=idle  Multiple operations

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

# Parse -t target and --json flag
resolve_pane_target "$@"
set -- "${RESOLVED_ARGS[@]}"

JSON=false
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --json) JSON=true ;;
    *) ARGS+=("$arg") ;;
  esac
done

TARGET_ARGS=()
if [ -n "$PANE_TARGET" ]; then
  TARGET_ARGS=(-t "$PANE_TARGET")
fi

# No args: list all metadata
if [ ${#ARGS[@]} -eq 0 ]; then
  META=$(get_all_pane_meta "${PANE_TARGET:-}")
  if [ -z "$META" ]; then
    if $JSON; then echo "{}"; fi
    exit 0
  fi
  if $JSON; then
    echo "$META" | meta_to_json
  else
    # Space-separated key=value pairs
    echo "$META" | tr '\n' ' '
    echo
  fi
  exit 0
fi

# Process args: key=value sets, bare key gets
SETS=()
GETS=()
for arg in "${ARGS[@]}"; do
  if [[ "$arg" == *=* ]]; then
    SETS+=("$arg")
  else
    GETS+=("$arg")
  fi
done

# Apply sets
if [ ${#SETS[@]} -gt 0 ]; then
  set_pane_meta "${PANE_TARGET:-}" "${SETS[@]}"
fi

# Build output
OUTPUT=""
for arg in "${ARGS[@]}"; do
  if [[ "$arg" == *=* ]]; then
    local_key="${arg%%=*}"
    local_val="${arg#*=}"
    if [ -n "$local_val" ]; then
      OUTPUT="${OUTPUT:+$OUTPUT }${local_key}=${local_val}"
    fi
  else
    validate_meta_key "$arg" || exit 1
    local_val=$(_tmux show-options -p "${TARGET_ARGS[@]}" -v "@tmuxy_ctx_${arg}" 2>/dev/null || true)
    if [ -n "$local_val" ]; then
      OUTPUT="${OUTPUT:+$OUTPUT }${arg}=${local_val}"
    fi
  fi
done

if [ -z "$OUTPUT" ]; then
  if $JSON; then echo "{}"; fi
  exit 0
fi

if $JSON; then
  echo "$OUTPUT" | tr ' ' '\n' | meta_to_json
else
  echo "$OUTPUT"
fi
