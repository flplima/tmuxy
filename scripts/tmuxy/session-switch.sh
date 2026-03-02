#!/bin/bash
# session-switch.sh — Interactive session switcher
#
# Standalone mode (default): switch tmux client to selected session
# Float mode (--float): set TMUXY_SWITCH_TO env var and exit (caller handles switch)
set -euo pipefail

float_mode=false
for arg in "$@"; do
  case "$arg" in
    --float) float_mode=true ;;
    --help|-h)
      echo "Usage: tmuxy session switch [--float]"
      echo ""
      echo "Interactive session switcher."
      echo "  --float   Set TMUXY_SWITCH_TO env var instead of switching directly"
      exit 0
      ;;
  esac
done

# Get current session
current=$(tmux display-message -p '#{session_name}')

# List all sessions
mapfile -t sessions < <(tmux list-sessions -F '#{session_name}')

if [ ${#sessions[@]} -eq 0 ]; then
  echo "No tmux sessions found."
  exit 1
fi

# Display numbered list
echo "Sessions:"
for i in "${!sessions[@]}"; do
  num=$((i + 1))
  name="${sessions[$i]}"
  if [ "$name" = "$current" ]; then
    echo "  $num) $name *"
  else
    echo "  $num) $name"
  fi
done
echo ""

# Prompt
read -rp 'Select session (number or "new"): ' choice

if [ "$choice" = "new" ]; then
  ts=$(date +%s)
  new_name="tmuxy_${ts}"
  tmux new-session -d -s "$new_name"
  selected="$new_name"
elif [[ "$choice" =~ ^[0-9]+$ ]]; then
  idx=$((choice - 1))
  if [ "$idx" -lt 0 ] || [ "$idx" -ge ${#sessions[@]} ]; then
    echo "Invalid selection." >&2
    exit 1
  fi
  selected="${sessions[$idx]}"
else
  echo "Invalid input." >&2
  exit 1
fi

echo "$selected"

if $float_mode; then
  tmux set-environment -g TMUXY_SWITCH_TO "$selected"
else
  tmux switch-client -t "$selected"
fi
