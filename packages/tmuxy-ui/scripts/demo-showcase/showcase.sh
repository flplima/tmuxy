#!/bin/bash
# The demo's showcase, built once in the guest by scripts/build-v86-snapshot.mjs
# after it saved the generic state, so the state saved after this holds the
# demo's finished session and the page has nothing left to build:
#
#   bash showcase.sh FROM TO
#
# FROM is the generic state's session (one window, two panes side by side),
# renamed TO. It runs outside tmux with no client attached, so every command
# names its target. What a pane is given runs on that pane's shell's time:
# the script ends only once every pane shows what it was given.
set -euo pipefail

from=${1:?usage: showcase.sh FROM TO}
s=${2:?usage: showcase.sh FROM TO}
here=$(cd "${0%/*}" && pwd)

type_line() {
  tmux send-keys -t "$1" -l "$2"
  tmux send-keys -t "$1" Enter
}

tmux rename-session -t "$from" "$s"
tmux rename-window -t "$s:" welcome
# Each window is left as an attach at the default size leaves it
# (GUEST_DEFAULT_COLS x _ROWS in GuestEngine.ts, pane titles on), so that
# attach changes no layout. A page makes it when the guest is up before the
# page has measured its viewport; one that has measured attaches at its
# viewport, and the attach resizes the windows before it captures them.
as_attached() {
  tmux set-option -w -t "$1" pane-border-status top
  tmux resize-window -t "$1" -x 80 -y 30
}
as_attached "$s:welcome"
printf 'Did you notice that this pane has two tabs?\n' >~/pane-group-1.txt
printf '%s\n' 'A pane group lets you stack several panes in the same position within your layout. The inactive panes live in hidden tmux windows.' '' 'When you switch tabs, tmuxy swaps the visible pane with the hidden one.' >~/pane-group-2.txt

# The second tab: a pane group on the left, an animated picture below it and
# a markdown preview on the right.
group=$(tmux new-window -P -F '#{pane_id}' -t "$s:" -n features)
as_attached "$s:features"
preview=$(tmux split-window -h -P -F '#{pane_id}' -t "$group")
image=$(tmux split-window -v -P -F '#{pane_id}' -t "$group")
# Typed before the shell is up, so its output starts on the prompt's line;
# `clear` puts the preview's marker at the start of one, where it is read.
type_line "$preview" "clear; cd $here && tmuxy open tmuxy.md"
tmux select-pane -t "$group"
# `group add` acts on the shell's own pane, so the group is built from there;
# the new member is the tab's active pane until the switch back.
type_line "$group" "clear; cat ~/pane-group-1.txt; tmuxy pane group add && tmux send-keys -t $s:features. 'clear; cat ~/pane-group-2.txt' Enter && tmuxy pane group switch \$TMUX_PANE && tmux set -g @tmuxy-showcase-built 1"

shows() { grep -qF -- "$2" <<<"$(tmux capture-pane -p -J -t "$1")"; }
built() { [ "$(tmux show -gqv @tmuxy-showcase-built)" = 1 ]; }
# The group's other member, parked in the stash session beside its keeper.
parked() {
  local want id gid
  want=$(tmux display -p -t "$group" '#{@tmuxy-group-id}')
  [ -n "$want" ] || return 1
  while read -r id gid; do
    if [ "$gid" = "$want" ] && shows "$id" 'When you switch tabs'; then return 0; fi
  done <<<"$(tmux list-panes -s -t __tmuxy_stash -F '#{pane_id} #{@tmuxy-group-id}' 2>/dev/null)"
  return 1
}
# icat is ready once it sleeps, waiting to be told its window is in front:
# a `sleep` whose parent runs icat.
waiting() {
  local stat comm ppid
  for stat in /proc/[0-9]*/stat; do
    read -r _ comm _ ppid _ <"$stat" 2>/dev/null || continue
    if [ "$comm" = '(sleep)' ] && grep -qF icat "/proc/$ppid/cmdline" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}
# Polls until "$@" holds, for five minutes at most in all.
wait_until() {
  until "$@"; do
    if [ "$SECONDS" -gt 300 ]; then
      echo "showcase: not finished after 5 minutes: $*" >&2
      exit 1
    fi
    sleep 0.2
  done
}
settled() {
  built && parked && shows "$group" 'two tabs?' && shows "$preview" '__REV__:'
}
wait_until settled
tmux set -gu @tmuxy-showcase-built

# The picture last, its tab already in the back as the demo starts: icat
# draws nothing there, and is asleep when the state is saved. It draws when
# a visitor brings the tab to the front.
tmux select-window -t "$s:welcome"
type_line "$image" "bash $here/icat $here/nyan-cat.gif"
wait_until waiting
