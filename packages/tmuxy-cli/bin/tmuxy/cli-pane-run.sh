#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — `pane run`, `pane wait` and
# `pane capture`: a program in a pane as a script sees it, with an exit status
# to wait for instead of a screen to poll.

# How often a waited-on pane is looked at. tmux emits no notification a
# browser-side client could relay, and a read-only `display-message` is cheap.
WAIT_POLL_INTERVAL=0.15

_wait_nap() { sleep "$WAIT_POLL_INTERVAL" 2>/dev/null || sleep 1; }

# A duration (`90`, `90s`, `10m`, `2h`) in seconds; a bad one is a usage error.
_duration_seconds() {
  local value="$1" n unit
  case "$value" in
    *[!0-9smh]* | '' | [smh]) _die_usage "not a duration: '$value' (use 30s, 10m, 2h)" ;;
  esac
  n="${value%[smh]}"
  unit="${value#"$n"}"
  case "$unit" in
    m) echo $((n * 60)) ;;
    h) echo $((n * 3600)) ;;
    *) echo "$n" ;;
  esac
}

# The answer to a wait: the program's status as the exit code, and as JSON.
# Args: $1=pane id, $2=status
_wait_done() {
  if [ "$JSON_OUT" = true ]; then
    local ok=false
    [ "$2" -eq 0 ] && ok=true
    printf '{"ok":%s,"paneId":%s,"status":%s}\n' "$ok" "$(json_string "$1")" "$2"
  fi
  exit "$2"
}

usage_pane_run() {
  cat <<'EOF'
Usage: tmuxy pane run [options] -- <command...>

Run a command in a new pane, split from this one, and print the pane's id.
With --wait, block until the command exits and exit with ITS status, so a
script can branch on it (`if tmuxy pane run --wait -- npm test; then …`).

Options:
  --wait            Wait for the command; exit with its status
  --for DURATION    With --wait: give up after 30s, 10m, 2h… (exit 1)
  --split right|below   Where the new pane goes (default: below)
  --ratio N         The new pane's share of the split, in percent
  --cwd DIR         Start the command in DIR
  --label L         Name the pane, for `-t L` on every other command
  --focus=false     Leave the focus where it is
  --keep-open       Keep the pane open after the command exits
  --json            {"ok":…,"paneId":"%N"} (with --wait: "status" too)
EOF
}

cmd_pane_run() {
  local wait=false keep_open=false split="-v" ratio="" cwd="" label="" focus="" for="" cmd=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h) usage_pane_run; return ;;
      --wait) wait=true; shift ;;
      --for) [ -n "${2:-}" ] || _die_usage "--for needs a duration"; for="$2"; shift 2 ;;
      --split)
        case "${2:-}" in
          right) split="-h" ;;
          below) split="-v" ;;
          *) _die_usage "--split takes right or below" ;;
        esac
        shift 2
        ;;
      --ratio)
        case "${2:-}" in
          '' | *[!0-9]*) _die_usage "--ratio takes a percentage" ;;
        esac
        ratio="$2"; shift 2
        ;;
      --cwd) [ -n "${2:-}" ] || _die_usage "--cwd needs a directory"; cwd="$2"; shift 2 ;;
      --label) [ -n "${2:-}" ] || _die_usage "--label needs a name"; label="$2"; shift 2 ;;
      --focus=false|--no-focus) focus=" -d"; shift ;;
      --focus=true|--focus) shift ;;
      --keep-open) keep_open=true; shift ;;
      --) shift; cmd=("$@"); break ;;
      -*) _die_usage "unknown option '$1'" usage_pane_run ;;
      *) cmd=("$@"); break ;;
    esac
  done
  [ ${#cmd[@]} -gt 0 ] || _die_usage "command required (after --)" usage_pane_run
  local deadline=""
  if [ -n "$for" ]; then
    local seconds
    seconds="$(_duration_seconds "$for")" || exit $?
    deadline=$(($(date +%s) + seconds))
  fi

  # The command runs through a wrapper script, as a float's does: it keeps
  # the command out of the tmux command list, where its quoting would have to
  # survive both the shell and tmux's parser, and it is what records the exit
  # status — tmux's own `pane_dead_status` needs remain-on-exit set before
  # the program can exit, which a fast one does before any second command.
  local dir
  dir=$(mktemp -d /tmp/tmuxy-run.XXXXXX)
  {
    echo '#!/bin/bash'
    # Each word quoted for the shell again: `sh -c "echo a; sleep 1"` is one
    # word to the caller and has to reach sh as one.
    printf '%q ' "${cmd[@]}"
    echo
    echo 'status=$?'
    echo "echo \$status > $(printf '%q' "$dir/status")"
    if $keep_open; then
      echo 'printf "\n[tmuxy: exited %s] press Enter to close\n" "$status"'
      echo 'read -r _'
    fi
    # Nobody waiting means nobody to clean up: the wrapper does it itself.
    $wait || echo "rm -rf $(printf '%q' "$dir")"
    echo 'exit "$status"'
  } > "$dir/run.sh"

  local flags="$split$focus"
  [ -z "$ratio" ] || flags="$flags -l $ratio%"
  [ -z "$cwd" ] || flags="$flags -c $(shquote "$cwd")"
  local out pane_id
  out=$(_run_safe "splitw$CALLER_T $flags -P -F '##{pane_id}' $(shquote "bash $dir/run.sh")")
  pane_id=$(echo "$out" | grep -o '%[0-9]*' | tail -1 || true)
  [ -n "$pane_id" ] || _fail "$EXIT_FAILED" "tmux created no pane"
  [ -z "$label" ] || _run_safe "set-option -p -t $pane_id @tmuxy-label $(shquote "$label")"

  if ! $wait; then
    if [ "$JSON_OUT" = true ]; then
      json_ok "paneId=$(json_string "$pane_id")"
    else
      echo "$pane_id"
    fi
    return 0
  fi

  [ "$JSON_OUT" = true ] || echo "$pane_id"
  local status
  while :; do
    if [ -f "$dir/status" ]; then
      status=$(cat "$dir/status")
      $keep_open || rm -rf "$dir"
      _wait_done "$pane_id" "${status:-1}"
    fi
    if ! _tmux_read display-message -p -t "$pane_id" '#{pane_id}' >/dev/null 2>&1; then
      rm -rf "$dir"
      _fail "$EXIT_FAILED" "$pane_id closed before the command reported its status"
    fi
    if [ -n "$deadline" ] && [ "$(date +%s)" -ge "$deadline" ]; then
      _fail "$EXIT_FAILED" "still running in $pane_id after $for"
    fi
    _wait_nap
  done
}

cmd_pane_wait() {
  local target="" for=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h)
        cat <<'EOF'
Usage: tmuxy pane wait <target> [--for DURATION]

Wait for the program in a pane to exit, and exit with its status. The pane
is kept open (remain-on-exit) so the status can be read; `tmuxy pane kill`
closes it. --for gives up after 30s, 10m, 2h… with exit 1.
EOF
        return
        ;;
      --for) [ -n "${2:-}" ] || _die_usage "--for needs a duration"; for="$2"; shift 2 ;;
      -*) _die_usage "unknown option '$1'" ;;
      *) target="$1"; shift ;;
    esac
  done
  [ -n "$target" ] || _die_usage "target required (a pane id or label)"
  local deadline=""
  if [ -n "$for" ]; then
    local seconds
    seconds="$(_duration_seconds "$for")" || exit $?
    deadline=$(($(date +%s) + seconds))
  fi
  local pane_id
  pane_id="$(_resolve_target "$target")" || exit $?
  _tmux_read display-message -p -t "$pane_id" '#{pane_id}' >/dev/null 2>&1 \
    || _fail "$EXIT_TARGET" "no such pane: $target"
  # Kept open once the program exits, or its status would die with it.
  _run_safe "set-option -p -t $(shquote "$pane_id") remain-on-exit on"

  local line dead status
  while :; do
    line=$(_tmux_read display-message -p -t "$pane_id" $'#{pane_dead}\t#{pane_dead_status}' 2>/dev/null) \
      || _fail "$EXIT_FAILED" "$pane_id went away"
    IFS=$'\t' read -r dead status <<<"$line"
    if [ "$dead" = 1 ]; then
      _wait_done "$pane_id" "${status:-0}"
    fi
    if [ -n "$deadline" ] && [ "$(date +%s)" -ge "$deadline" ]; then
      _fail "$EXIT_FAILED" "still running in $pane_id after $for"
    fi
    _wait_nap
  done
}

cmd_pane_capture() {
  local target="" trim=false flags=(-p) format=text
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h)
        cat <<'EOF'
Usage: tmuxy pane capture [-t <target>|<target>] [--trim] [--unwrap] [--format text|vt|html] [--json]

What is on a pane's screen. --trim drops trailing spaces and blank lines;
--unwrap joins lines the pane wrapped; --format vt keeps the colours as
escape sequences, html renders them as spans.
EOF
        return
        ;;
      -t) [ -n "${2:-}" ] || _die_usage "-t needs a pane or label"; target="$2"; shift 2 ;;
      --trim) trim=true; shift ;;
      --unwrap) flags+=(-J); shift ;;
      --format)
        case "${2:-}" in
          text|vt|html) format="$2" ;;
          *) _die_usage "--format takes text, vt or html" ;;
        esac
        shift 2
        ;;
      -*) _die_usage "unknown option '$1'" ;;
      *) target="$1"; shift ;;
    esac
  done
  [ "$format" = text ] || flags+=(-e)
  _pane_t "$target"
  local content
  content=$(_tmux_read capture-pane "${flags[@]}" ${PANE_ID:+-t "$PANE_ID"}) || exit $?
  if $trim; then
    content=$(printf '%s\n' "$content" | awk '{ sub(/[ \t]+$/, ""); line[NR] = $0; if ($0 != "") last = NR } END { for (i = 1; i <= last; i++) print line[i] }')
  fi
  if [ "$format" = html ]; then
    content=$(printf '%s\n' "$content" | awk -f "$SCRIPTS_DIR/capture-html")
  fi
  if [ "$JSON_OUT" = true ]; then
    printf '{"content":%s,"format":"%s","paneId":%s}\n' "$(json_string "$content")" "$format" "$(json_string "$PANE_ID")"
  else
    printf '%s\n' "$content"
  fi
}
