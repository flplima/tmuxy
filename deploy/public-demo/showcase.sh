#!/bin/bash
# Entrypoint for the public read-only demo: build a session worth looking at,
# then serve it to viewers who cannot touch it.
#
# The session is scripted rather than interactive. A viewer cannot type — the
# server refuses every non-read command — so a bare shell prompt would sit there
# doing nothing. Each pane instead runs something that keeps moving, which is
# what makes a read-only view worth opening.
set -euo pipefail

SOCKET="${TMUX_SOCKET:-tmuxy-public}"
PORT="${TMUXY_PORT:-9000}"
# `tmuxy` because that is the name a client that names no session asks for, and
# it is a COMPILE-TIME constant on that path (tmuxy_core::DEFAULT_SESSION_NAME,
# used by SessionQuery::session) — the TMUXY_SESSION env var does not move it.
# Get this wrong and the server quietly creates an empty session of its own
# beside this one, and the demo shows a bare prompt with nothing saying why.
SESSION="${TMUXY_SESSION:-tmuxy}"

tmux() { command tmux -L "$SOCKET" "$@"; }

# The server creates and adopts the session itself when it attaches, but it does
# so with a single plain shell. Laying the panes out first is what decides what a
# viewer sees; doing it before the server attaches keeps every mutation here off
# the control-mode connection (see docs/TMUX.md).
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -x 200 -y 50 -n tour

  # Pane 0: what this is, held on screen.
  tmux send-keys -t "$SESSION:tour.0" \
    'clear; cat /usr/local/share/tmuxy-demo/welcome.txt 2>/dev/null || echo "tmuxy — a read-only view of a real tmux session"; while :; do sleep 3600; done' C-m

  # Pane 1: a live clock and load, so it is visibly a real session and not a
  # screenshot.
  tmux split-window -t "$SESSION:tour" -h
  tmux send-keys -t "$SESSION:tour.1" \
    'while :; do clear; date -u "+%Y-%m-%d %H:%M:%SZ"; echo; uptime; sleep 1; done' C-m

  # Pane 2: scrolling output, which is what exercises the renderer.
  tmux split-window -t "$SESSION:tour.1" -v
  tmux send-keys -t "$SESSION:tour.2" \
    'i=0; while :; do i=$((i+1)); printf "%6d  the quick brown fox jumps over the lazy dog\n" "$i"; sleep 0.4; done' C-m

  tmux select-pane -t "$SESSION:tour.0"
fi

# The public names a tunnel may forward, as repeated flags. Built as an array
# rather than an unquoted expansion so an empty or comma-separated value cannot
# turn into a stray argument.
hosts=()
if [[ -n "${TMUXY_ALLOWED_HOSTS:-}" ]]; then
  IFS=',' read -ra names <<<"$TMUXY_ALLOWED_HOSTS"
  for name in "${names[@]}"; do
    [[ -n "$name" ]] && hosts+=(--allowed-host "$name")
  done
fi

# `--no-auth` on 0.0.0.0 is safe here only because of the container: see the
# note at the bottom of the Dockerfile. `--read-only` is also set through
# TMUXY_READ_ONLY, and passed again so it is visible in `ps`.
exec tmuxy-server \
  --port "$PORT" \
  --host 0.0.0.0 \
  --no-auth \
  --read-only \
  "${hosts[@]+"${hosts[@]}"}"
