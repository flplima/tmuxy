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
      local name=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy tab create [name] [--json]"; return ;;
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
        --help|-h) echo "Usage: tmuxy tab rename <name>"; return ;;
        "") _die_usage "name required" ;;
      esac
      _run_safe "rename-window$CALLER_T $(shquote "$1")"
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

    diff)
      JSON_OUT="$JSON_OUT" exec "$SCRIPTS_DIR/tmuxy-widget-diff" "$@"
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
