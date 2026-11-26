#!/usr/bin/env bash

# A tab to act on: an `@id`, an index or a `session:window` target is handed
# back as written; anything else is a tab NAME, which must name exactly one
# window (exit 3 otherwise, with nothing changed).
_resolve_tab() {
  local target="$1" rows matches count rc=0
  case "$target" in
    @[0-9]* | [0-9]* | \$[0-9]* | %[0-9]* | *:* | '{'*) printf '%s' "$target"; return 0 ;;
  esac
  rows="$(_tmux_read list-windows -a -F $'#{window_id}\t#{window_name}\t#{session_name}' 2>/dev/null)" || rc=$?
  _exit_if_no_server "$rc"
  matches="$(printf '%s\n' "$rows" | awk -F'\t' -v want="$target" '$2 == want { print $1 "\t" $3 }')"
  [ -n "$matches" ] || _fail "$EXIT_TARGET" "no tab named '$target'"
  count="$(printf '%s\n' "$matches" | wc -l | tr -d ' ')"
  if [ "$count" -ne 1 ]; then
    if [ "$JSON_OUT" != true ]; then
      echo "Error: '$target' names $count tabs; nothing changed. Pass the tab id:" >&2
      printf '%s\n' "$matches" | awk -F'\t' '{ printf "  %s  (session %s)\n", $1, $2 }' >&2
      exit "$EXIT_TARGET"
    fi
    _fail "$EXIT_TARGET" "'$target' names $count tabs; nothing changed"
  fi
  printf '%s' "${matches%%$'\t'*}"
}

_tab_t() {
  TAB_ID=""
  TAB_T="$CALLER_T"
  [ -n "${1:-}" ] || return 0
  TAB_ID="$(_resolve_tab "$1")" || exit $?
  TAB_T=" -t $(shquote "$TAB_ID")"
}

# --- Tab subcommands ---

cmd_tab() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    list)
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy tab list [--json]"; return ;;
          *) _die_usage "invalid argument '$arg'" ;;
        esac
      done
      if [ "$JSON_OUT" = true ]; then
        # Floats and sidebars are tmuxy's hidden windows; an untagged window
        # is a tab, as in a plain (non-tmuxy) session.
        local rows
        rows=$(_tmux_read list-windows -F "$LIST_WINDOWS_JSON_FMT") || exit $?
        printf '%s\n' "$rows" | \
          awk -F'\t' -v float="$WINDOW_TYPE_FLOAT" -v left="$WINDOW_TYPE_SIDEBAR_LEFT" -v right="$WINDOW_TYPE_SIDEBAR_RIGHT" "$JSON_AWK"'BEGIN{printf "["; n=0} NF>0 && $6!=float && $6!=left && $6!=right{ if(n++) printf ","; printf "{\"id\":\"%s\",\"index\":%s,\"name\":\"%s\",\"panes\":%s,\"active\":%s}", jstr($1), $2, jstr($3), $4, ($5=="1"?"true":"false")} END{printf "]\n"}'
      else
        _tmux_read list-windows
      fi
      ;;

    create)
      # After `--` a word is the name, a leading dash and all.
      local name="" named=false
      for arg in "$@"; do
        if [ "$named" = true ]; then
          [ -n "$name" ] || name="$arg"
          continue
        fi
        case "$arg" in
          --help|-h) echo "Usage: tmuxy tab create [--json] [--] [name]"; return ;;
          --) named=true ;;
          -*) _die_usage "invalid argument '$arg'" ;;
          *) [ -z "$name" ] && name="$arg" ;;
        esac
      done
      # The tab itself is the server binary's `new-tab` (tmuxy-core
      # `tmux_command::NewTab`).
      find_server_cmd || exit "$EXIT_FAILED"
      # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
      exec "${SERVER_CMD[@]}" new-tab ${server_json[@]+"${server_json[@]}"} -- ${name:+"$name"}
      ;;

    kill)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab kill [target]"; return ;;
      esac
      _tab_t "${1:-}"
      # The killed tab's parked group members are left in the stash, so the
      # sweep goes in the same command list: a `tab kill` of the caller's own
      # tab ends this shell with it, and a second command would never run.
      _run_safe "killw$TAB_T \\; run-shell $(shquote "bash $SCRIPTS_DIR/pane-group gc")"
      _done "tabId=$(json_string "$TAB_ID")"
      ;;

    select)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab select <index|@id|name>"; return ;;
        "") _die_usage "tab index, @id or name required" ;;
      esac
      _tab_t "$1"
      _run_safe "select-window$TAB_T"
      _done "tabId=$(json_string "$TAB_ID")"
      ;;

    next|prev)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab $sub"; return ;;
      esac
      if [ "$sub" = next ]; then
        _run_safe "next-window$CALLER_T"
      else
        _run_safe "previous-window$CALLER_T"
      fi
      _done
      ;;

    rename)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab rename [--] <name>"; return ;;
        --) shift ;;
      esac
      [ -n "${1:-}" ] || _die_usage "name required"
      _run_safe "rename-window$CALLER_T $(operand "$1")"
      _done "name=$(json_string "$1")"
      ;;

    layout)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab layout [next|even-h|even-v|main-h|main-v|tiled]"; return ;;
      esac
      local layout="${1:-next}"
      case "$layout" in
        next) _run_safe "next-layout$CALLER_T" ;;
        even-horizontal|even-vertical|main-horizontal|main-vertical|tiled|even-h|even-v|main-h|main-v)
          _run_safe "select-layout$CALLER_T $(shquote "$layout")" ;;
        *) _die_usage "invalid layout '$layout'. Use next, even-h, even-v, main-h, main-v or tiled" ;;
      esac
      _done "layout=$(json_string "$layout")"
      ;;

    --help|-h|"")
      usage_tab
      ;;

    *)
      _die_usage "Unknown tab command: $sub" usage_tab
      ;;
  esac
}

# --- Widget subcommands ---

cmd_widget() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    tree)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy widget tree"; return ;;
      esac
      exec "$SCRIPTS_DIR/tmuxy-widget-tree"
      ;;

    preview)
      JSON_OUT="$JSON_OUT" exec "$SCRIPTS_DIR/tmuxy-widget-preview" "$@"
      ;;

    --help|-h)
      usage_widget
      ;;

    "")
      usage_widget
      ;;

    *)
      _die_usage "Unknown widget command: $sub" usage_widget
      ;;
  esac
}

# --- Session subcommands ---

# --- Session verbs: new, rename, kill ---

# Is a session named exactly `$1` on the server? Exact, never a prefix: tmux's
# own `-t name` matches prefixes.
_session_exists() {
  local names rc=0
  names=$(_tmux_read list-sessions -F '#{session_name}' 2>/dev/null) || rc=$?
  _exit_if_no_server "$rc"
  case $'\n'"$names"$'\n' in *$'\n'"$1"$'\n'*) return 0 ;; esac
  return 1
}

# A name tmux keeps as written: it turns `:` and `.` into `_`, and a leading
# `-` would read as an option.
_check_session_name() {
  case "$1" in
    "") _die_usage "the session needs a name" ;;
    -*) _die_usage "a session name cannot start with '-'" ;;
    *[:.]*) _die_usage "a session name cannot hold ':' or '.'" ;;
    *[[:cntrl:]]*) _die_usage "a session name takes no control characters" ;;
  esac
  [ "$1" != "$STASH_SESSION" ] || _die_usage "'$1' is tmuxy's own"
}

# The answer of a session verb: the name, or `{"ok":true,"session":…}`.
_session_answer() {
  if [ "$JSON_OUT" = true ]; then
    json_ok "session=$(json_string "$1")"
  else
    echo "$1"
  fi
}

usage_session_new() {
  cat <<'EOF'
Usage: tmuxy session new [name] [--cwd DIR] [--json] [-- command...]

Create a session, detached: your own client stays where it is. With no name
it gets a memorable one (`quiet-meadow`). A name a session already has exits
1 and creates nothing. Prints the session's name.

Options:
  --cwd DIR    Start the first pane in DIR (exit 2 when it is no directory)
  --json       {"ok":true,"session":"<name>"}
  -- command   Run this in the first pane instead of the shell
EOF
}

cmd_session_new() {
  local name="" cwd="" cmd=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h) usage_session_new; return ;;
      --cwd) [ -n "${2:-}" ] || _die_usage "--cwd needs a directory"; cwd="$2"; shift 2 ;;
      --) shift; cmd=("$@"); break ;;
      -*) _die_usage "unknown option '$1'" usage_session_new ;;
      *)
        [ -z "$name" ] || _die_usage "one name only: '$name' and '$1'" usage_session_new
        name="$1"; shift
        ;;
    esac
  done
  if [ -n "$cwd" ] && [ ! -d "$cwd" ]; then
    _die_usage "--cwd: no such directory: $cwd"
  fi
  if [ -z "$name" ]; then
    name="$(memorable_session_name)"
  else
    _check_session_name "$name"
    ! _session_exists "$name" || _fail "$EXIT_FAILED" "a session named '$name' exists; nothing created"
  fi

  local flags word shell_cmd=""
  flags="-d -s $(shquote "$name")"
  [ -z "$cwd" ] || flags="$flags -c $(shquote "$cwd")"
  if [ ${#cmd[@]} -gt 0 ]; then
    for word in "${cmd[@]}"; do shell_cmd="$shell_cmd $(shquote "$word")"; done
    flags="$flags $(shquote "${shell_cmd# }")"
  fi
  _run_safe "new-session $flags" || _fail "$EXIT_FAILED" "tmux created no session"
  _session_answer "$name"
}

usage_session_rename() {
  cat <<'EOF'
Usage: tmuxy session rename [session] <new-name> [--json]

Rename a session; with one argument, the one you are in. A name another
session has exits 1. --json answers {"ok":true,"session":"<new-name>"}. The
session's snapshot, if any, keeps the old name until the session is saved
again.
EOF
}

cmd_session_rename() {
  local args=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h) usage_session_rename; return ;;
      -*) _die_usage "unknown option '$1'" usage_session_rename ;;
      *) args+=("$1"); shift ;;
    esac
  done
  local old="" new=""
  case ${#args[@]} in
    1) new="${args[0]}" ;;
    2) old="${args[0]}"; new="${args[1]}" ;;
    *) _die_usage "a new name is required" usage_session_rename ;;
  esac
  _check_session_name "$new"
  if [ -z "$old" ]; then
    local rc=0
    old="$(_tmux_read display-message -p ${TMUX_PANE:+-t "$TMUX_PANE"} '#{session_name}')" || rc=$?
    _exit_if_no_server "$rc"
    [ -n "$old" ] || _fail "$EXIT_FAILED" "run this inside a tmuxy pane, or name the session"
  else
    _session_exists "$old" || _fail "$EXIT_TARGET" "no session named '$old'"
  fi
  [ "$old" != "$new" ] || _fail "$EXIT_FAILED" "the session is already named '$new'"
  ! _session_exists "$new" || _fail "$EXIT_FAILED" "a session named '$new' exists; nothing renamed"
  _run_safe "rename-session -t $(shquote "=$old") $(shquote "$new")" \
    || _fail "$EXIT_FAILED" "tmux did not rename '$old'"
  _session_answer "$new"
}

usage_session_kill() {
  cat <<'EOF'
Usage: tmuxy session kill <session> [--json]

Kill a session and every pane in it. The session is always named: there is
no default, so a script cannot kill the one it runs in by leaving the name
out. A session that does not exist exits 3. --json answers
{"ok":true,"session":"<name>"}.

The session's snapshot stays, marked exited, so `tmuxy session restore`
brings it back; `tmuxy session forget <name>` deletes it.
EOF
}

cmd_session_kill() {
  local name=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h) usage_session_kill; return ;;
      -*) _die_usage "unknown option '$1'" usage_session_kill ;;
      *)
        [ -z "$name" ] || _die_usage "one session only" usage_session_kill
        name="$1"; shift
        ;;
    esac
  done
  [ -n "$name" ] || _die_usage "a session name is required" usage_session_kill
  [ "$name" != "$STASH_SESSION" ] || _die_usage "'$name' is tmuxy's own"
  _session_exists "$name" || _fail "$EXIT_TARGET" "no session named '$name'"
  _run_safe "kill-session -t $(shquote "=$name")" \
    || _fail "$EXIT_FAILED" "tmux did not kill '$name'"
  _session_answer "$name"
}

cmd_session() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    switch)
      case "${1:-}" in
        --help|-h) exec bash "$SCRIPTS_DIR/session-switch" --help ;;
      esac
      exec bash "$SCRIPTS_DIR/session-switch" "$@"
      ;;

    connect)
      session_connect "$@"
      ;;

    new)
      cmd_session_new "$@"
      ;;
    rename)
      cmd_session_rename "$@"
      ;;
    kill)
      cmd_session_kill "$@"
      ;;

    save|snapshots)
      # Reads only (tmux queries and `ps`), safe as a plain subprocess.
      find_server_cmd || exit "$EXIT_FAILED"
      # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
      exec "${SERVER_CMD[@]}" session "$sub" ${server_json[@]+"${server_json[@]}"} "$@"
      ;;

    restore)
      # A restore creates and splits, which must not run as bare tmux
      # subprocesses while a control-mode client is attached (docs/TMUX.md).
      # Inside `run-shell` the binary's own tmux calls are tmux-internal, the
      # same way every mutating helper in bin/tmuxy runs.
      case "${1:-}" in
        --help|-h) find_server_cmd; exec "${SERVER_CMD[@]}" session restore --help ;;
      esac
      # `--run` starts every pane's saved command without offering it first.
      # A person at a terminal can say so; a script or an agent, with no
      # terminal, gets the restore with each command offered instead.
      local quoted="" arg stdin_tty="" tty_redir=""
      for arg in "$@"; do
        if [ "$arg" = "--run" ]; then
          if ! [ -t 0 ]; then
            _fail "$EXIT_USAGE" "--run needs a terminal; without it each command is offered in its pane"
          fi
          stdin_tty="$(tty 2>/dev/null || true)"
        fi
        quoted="$quoted $(shquote "$arg")"
      done
      [ -z "$stdin_tty" ] || [ ! -c "$stdin_tty" ] || tty_redir=" < $(shquote "$stdin_tty")"
      find_server_cmd
      _run_shell "$(shquote "${SERVER_CMD[@]}") session restore$(_json_flag)$quoted$tty_redir"
      ;;

    forget)
      # `--force` kills a running session first: a kill is a mutation, so it
      # goes through run-shell; the file removal needs nothing from tmux.
      case "${1:-}" in
        --help|-h) find_server_cmd; exec "${SERVER_CMD[@]}" session forget --help ;;
      esac
      local quoted=""
      for arg in "$@"; do quoted="$quoted $(shquote "$arg")"; done
      find_server_cmd
      _run_shell "$(shquote "${SERVER_CMD[@]}") session forget$(_json_flag)$quoted"
      ;;

    --help|-h)
      usage_session
      ;;

    "")
      usage_session
      ;;

    *)
      _die_usage "Unknown session command: $sub" usage_session
      ;;
  esac
}

# --- Nav subcommand ---

cmd_nav() {
  local dir="${1:-}"

  case "$dir" in
    # The calling pane is $TMUX_PANE. run-shell's own `#{pane_id}` expands to
    # the session's current pane, which is a different pane when this runs
    # from inside a sidebar column — the nav script needs to know it is there.
    # (Resolved in two steps: `${TMUX_PANE:-#{pane_id}}` would let bash close
    # the expansion at the `}` inside the tmux format.)
    left|right|up|down|next|prev)
      local pane_arg="${TMUX_PANE:-}"
      [ -n "$pane_arg" ] || pane_arg='#{pane_id}'
      _run_shell "bash '$SCRIPTS_DIR/nav' $dir $pane_arg"
      _done "direction=$(json_string "$dir")"
      ;;
    --help|-h|"")
      usage_nav
      ;;
    *)
      _die_usage "Unknown direction: $dir" usage_nav
      ;;
  esac
}

# --- Run escape hatch ---

# What runs, what is refused and the help are the server binary's `run`
# (tmuxy-core `command_router::route_cli_run`).
cmd_run() {
  find_server_cmd || exit "$EXIT_FAILED"
  # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
  exec "${SERVER_CMD[@]}" run ${server_json[@]+"${server_json[@]}"} -- "$@"
}

# --- Connect to a different tmux server (desktop app) ---

# The stages, the checks and the request are the server binary's
# `session-connect` and `connect` (tmuxy-verbs `connect_cli`).
session_connect() {
  find_server_cmd || exit "$EXIT_FAILED"
  # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
  exec "${SERVER_CMD[@]}" session-connect ${server_json[@]+"${server_json[@]}"} "$@"
}

cmd_connect() {
  case "${1:-}" in
    --help|-h) usage_connect; return ;;
    "") session_connect ;;
  esac
  find_server_cmd || exit "$EXIT_FAILED"
  # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
  exec "${SERVER_CMD[@]}" connect ${server_json[@]+"${server_json[@]}"} --socket "$1" ${2:+--session "$2"}
}
