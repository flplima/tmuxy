#!/usr/bin/env bash
#
# Kill any process listening on a given TCP port.
# Works in minimal containers without lsof/fuser/ss.
#
# Usage: kill-port.sh <port>
#

PORT="${1:?Usage: kill-port.sh <port>}"
HEX=$(printf '%04X' "$PORT")

# Collect socket inodes listening (state 0A = LISTEN) on this port
INODES=()
for proto in /proc/net/tcp /proc/net/tcp6; do
  [ -f "$proto" ] || continue
  while read -r _ local _ state _ _ _ _ _ inode _; do
    if [[ "$local" == *":$HEX" && "$state" == "0A" ]]; then
      INODES+=("$inode")
    fi
  done < "$proto"
done

[ ${#INODES[@]} -eq 0 ] && exit 0

# Find PIDs owning those inodes
PIDS=()
for pid_dir in /proc/[0-9]*; do
  pid="${pid_dir##*/}"
  fd_dir="$pid_dir/fd"
  [ -d "$fd_dir" ] || continue
  for fd in "$fd_dir"/*; do
    link=$(readlink "$fd" 2>/dev/null) || continue
    for inode in "${INODES[@]}"; do
      if [[ "$link" == "socket:[$inode]" ]]; then
        PIDS+=("$pid")
      fi
    done
  done
done

# Deduplicate and kill
declare -A seen
for pid in "${PIDS[@]}"; do
  if [ -z "${seen[$pid]}" ]; then
    seen[$pid]=1
    echo "[kill-port] Killing PID $pid on port $PORT"
    kill "$pid" 2>/dev/null || true
  fi
done

# Wait briefly for processes to exit
sleep 1
