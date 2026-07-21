#!/usr/bin/env bash
# Regenerate the pane-reflow parity fixtures from a real tmux server.
#
# The fixtures pin what tmux ACTUALLY shows in a pane after a resize, so
# `pane_reflow_parity.rs` can assert that tmuxy's emulator lands the same
# content on the same rows — without needing tmux at test time (CI's
# rust-tests job has no tmux).
#
# Usage: ./regenerate.sh [path-to-tmux]
set -euo pipefail

TMUX_BIN="${1:-tmux}"
SOCK="tmuxy-reflow-fixture-$$"
HERE="$(cd "$(dirname "$0")" && pwd)"
RAW="$HERE/session.bin"

cleanup() { "$TMUX_BIN" -L "$SOCK" kill-server 2>/dev/null || true; }
trap cleanup EXIT

rm -f "$RAW" "$HERE"/*.txt

# Window height 21 => pane height 20 (tmux status bar takes one row).
"$TMUX_BIN" -L "$SOCK" new-session -d -s t -x 80 -y 21
sleep 1
PANE=$("$TMUX_BIN" -L "$SOCK" display-message -p '#{pane_id}')

# Record the raw pty byte stream, which is what tmuxy's emulator is fed.
"$TMUX_BIN" -L "$SOCK" pipe-pane -o -t "$PANE" "cat >> $RAW"
sleep 0.5

# More than one screenful, so rows must scroll off the top into scrollback.
"$TMUX_BIN" -L "$SOCK" send-keys -t "$PANE" \
  'clear; for i in $(seq 1 30); do echo "LINE-$i"; done' Enter
sleep 2

# Stop recording BEFORE resizing: a resize emits no application bytes at all.
# tmux reflows its own grid internally, and the emulator has to match that
# purely from set_size -- which is exactly what the fixtures below pin down.
"$TMUX_BIN" -L "$SOCK" pipe-pane -t "$PANE"

capture() { "$TMUX_BIN" -L "$SOCK" capture-pane -p -t "$PANE" > "$HERE/$1"; }
geom() { "$TMUX_BIN" -L "$SOCK" display-message -p -t "$PANE" "$1"; }

capture h20.txt
echo "baseline pane: $(geom '#{pane_width}')x$(geom '#{pane_height}')"

"$TMUX_BIN" -L "$SOCK" resize-window -t t -x 80 -y 13; sleep 1
capture h12.txt
echo "shrunk pane:   $(geom '#{pane_width}')x$(geom '#{pane_height}')"

"$TMUX_BIN" -L "$SOCK" resize-window -t t -x 80 -y 21; sleep 1
capture h20-again.txt
echo "regrown pane:  $(geom '#{pane_width}')x$(geom '#{pane_height}')"

echo "wrote $RAW and $HERE/*.txt"
