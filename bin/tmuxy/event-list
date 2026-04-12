#!/bin/bash
# tmuxy event list — show pending events across all channels
#
# Usage: tmuxy event list

set -euo pipefail
shopt -s nullglob

SOCKET="${TMUX_SOCKET:-default}"
BASE="/tmp/tmuxy-events/$SOCKET"

if [ ! -d "$BASE" ]; then
  echo "No event channels."
  exit 0
fi

found=false
for channel_dir in "$BASE"/*/; do
  [ -d "$channel_dir" ] || continue
  found=true
  name="$(basename "$channel_dir")"
  cursor=$(cat "$channel_dir/cursor" 2>/dev/null || echo -1)
  next=$(cat "$channel_dir/next" 2>/dev/null || echo 0)

  # Count pending messages (N > cursor)
  pending=0
  first_payload=""
  first_n=""
  for f in "$channel_dir"/msg.[0-9]*; do
    [ -f "$f" ] || continue
    n="${f##*/msg.}"
    case "$n" in *.tmp) continue ;; esac
    if [ "$n" -gt "$cursor" ]; then
      pending=$((pending + 1))
      if [ -z "$first_n" ] || [ "$n" -lt "$first_n" ]; then
        first_n="$n"
        first_payload="$(head -c 80 "$f" 2>/dev/null || true)"
      fi
    fi
  done

  printf "%-20s pending=%d  cursor=%s  next=%s" "$name" "$pending" "$cursor" "$next"
  if [ -n "$first_payload" ]; then
    printf "  next_msg: %.80s" "$first_payload"
  fi
  printf "\n"
done

if ! $found; then
  echo "No event channels."
fi
