#!/usr/bin/env bash
# Sourced by bin/tmuxy-cli — tab, widget, session, nav, open, run and connect subcommands.

# --- Tab subcommands ---

cmd_tab() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    list)
      local json=false
      for arg in "$@"; do
        case "$arg" in
          --json) json=true ;;
          --help|-h) echo "Usage: tmuxy tab list [--json]"; return ;;
        esac
      done
      if $json; then
        # Include @tmuxy-window-type ($6) so we can drop tmuxy's hidden windows
        # (floats and the sidebars). Keep "tab" and untagged/foreign ("")
        # windows so this still works in a plain (non-tmuxy) session.
        # Tab-separated: window_name is user-controlled free text (tmuxy tab
        # rename), so a comma in it would shift every following field.
        _tmux list-windows -F "$LIST_WINDOWS_JSON_FMT" | \
          awk -F'\t' "$JSON_ESCAPE_AWK"'BEGIN{printf "["; n=0} $6!="float" && $6!~/^sidebar-/{ if(n++) printf ","; printf "{\"id\":\"%s\",\"index\":%s,\"name\":\"%s\",\"panes\":%s,\"active\":%s}", jstr($1), $2, jstr($3), $4, ($5=="1"?"true":"false")} END{printf "]\n"}'
      else
        _tmux list-windows
      fi
      ;;

    create)
      local name="" json=false
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy tab create [name] [--json]"; return ;;
          --json) json=true ;;
          *) [ -z "$name" ] && name="$arg" ;;
        esac
      done
      # new-window crashes tmux 3.5a — use splitw+breakp as a single tmux command
      # list (separated by \;) so it runs atomically through run-shell. Direct
      # external tmux invocations crash CC; this routes through run-shell safely.
      # splitw+breakp creates the new window and selects it. Tabs carry no
      # marker — an untagged window in the session is a tab, so no tagging.
      # The break names its session: `#{session_id}` is run-shell's, expanded
      # for the calling pane, where a bare breakp would put the window in
      # whichever session tmux last touched (see TMUX_PANE above).
      local out
      if [ -n "$name" ]; then
        out=$(_run_safe "splitw \\; breakp -t '#{session_id}:' -n $(shquote "$name") -P -F '##{window_id}'")
      else
        out=$(_run_safe "splitw \\; breakp -t '#{session_id}:' -P -F '##{window_id}'")
      fi
      local tab_id
      tab_id=$(echo "$out" | grep -o '@[0-9]*' | tail -1 || true)
      if $json; then
        printf '{"tabId":"%s"}\n' "${tab_id:-}"
      elif [ -n "$tab_id" ]; then
        echo "$tab_id"
      fi
      ;;

    kill)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab kill [@id]"; return ;;
      esac
      local target="${1:-}"
      if [ -n "$target" ]; then
        _run_safe "killw -t $(shquote "$target")"
      else
        _run_safe "killw"
      fi
      ;;

    select)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab select <index|@id>"; return ;;
        "") echo "Error: tab index or @id required" >&2; return 1 ;;
      esac
      _run_safe "select-window -t $(shquote "$1")"
      ;;

    next)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab next"; return ;;
      esac
      _run_safe "next-window"
      ;;

    prev)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab prev"; return ;;
      esac
      _run_safe "previous-window"
      ;;

    rename)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab rename <name>"; return ;;
        "") echo "Error: name required" >&2; return 1 ;;
      esac
      _run_safe "rename-window $(shquote "$1")"
      ;;

    layout)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab layout [next|even-h|even-v|main-h|main-v|tiled]"; return ;;
      esac
      local layout="${1:-next}"
      if [ "$layout" = "next" ]; then
        _run_safe "next-layout"
      else
        _run_safe "select-layout $(shquote "$layout")"
      fi
      ;;

    --help|-h)
      usage_tab
      ;;

    "")
      usage_tab
      ;;

    *)
      echo "Unknown tab command: $sub" >&2
      usage_tab >&2
      return 1
      ;;
  esac
}

# --- Widget subcommands ---

cmd_widget() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    browser)
      case "${1:-}" in
        --help|-h)
          cat <<'BEOF'
Usage: tmuxy widget browser [--color-filter] <file|url|->

Options:
  --color-filter  Recolour a page or an image into the theme's colours
                  (markdown is already drawn in them)
BEOF
          return ;;
        "") echo "Error: file, url or - required" >&2; return 1 ;;
      esac
      open_target "$@"
      ;;

    tree)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy widget tree"; return ;;
      esac
      exec "$SCRIPTS_DIR/tmuxy-widget-tree"
      ;;

    session)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy widget session"; return ;;
      esac
      exec "$SCRIPTS_DIR/tmuxy-widget-session"
      ;;

    --help|-h)
      usage_widget
      ;;

    "")
      usage_widget
      ;;

    *)
      echo "Unknown widget command: $sub" >&2
      usage_widget >&2
      return 1
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
      case "${1:-}" in
        --help|-h) exec bash "$SCRIPTS_DIR/session-connect" --help ;;
      esac
      exec bash "$SCRIPTS_DIR/session-connect" "$@"
      ;;

    save|snapshots)
      # Reads only (tmux queries and `ps`), safe as a plain subprocess.
      find_server_cmd
      exec "${SERVER_CMD[@]}" session "$sub" "$@"
      ;;

    restore)
      # A restore creates and splits, which must not run as bare tmux
      # subprocesses while a control-mode client is attached (docs/TMUX.md).
      # Inside `run-shell` the binary's own tmux calls are tmux-internal, the
      # same way every mutating helper in bin/tmuxy runs.
      case "${1:-}" in
        --help|-h) find_server_cmd; exec "${SERVER_CMD[@]}" session restore --help ;;
      esac
      local quoted=""
      for arg in "$@"; do quoted="$quoted $(shquote "$arg")"; done
      find_server_cmd
      _run_shell "$(shquote "${SERVER_CMD[@]}") session restore$quoted"
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
      _run_shell "$(shquote "${SERVER_CMD[@]}") session forget$quoted"
      ;;

    --help|-h)
      usage_session
      ;;

    "")
      usage_session
      ;;

    *)
      echo "Unknown session command: $sub" >&2
      usage_session >&2
      return 1
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
      ;;
    --help|-h)
      usage_nav
      ;;
    "")
      usage_nav
      ;;
    *)
      echo "Unknown direction: $dir" >&2
      usage_nav >&2
      return 1
      ;;
  esac
}

# --- Opening something in a browser pane ---

# `tmuxy open` / `tmuxy widget browser`: a website goes to the real engine
# (`tmuxy browser`), which draws it in the pane under the app's address bar —
# a frame cannot show a site that refuses to be framed, and most big ones do.
# Files, markdown and images stay with the widget, which draws them in the
# theme. `-` (markdown on stdin) is never resolved first: resolving reads it.
open_target() {
  local filter="" arg resolved
  for arg in "$@"; do
    case "$arg" in
      --color-filter) filter=1 ;;
      - | --resolve) exec "$SCRIPTS_DIR/tmuxy-widget-browser" "$@" ;;
    esac
  done
  resolved=$("$SCRIPTS_DIR/tmuxy-widget-browser" --resolve "$@") || exit $?
  case "$resolved" in
    http://* | https://*)
      find_server_cmd
      TMUXY_CLI="$SELF" exec "${SERVER_CMD[@]}" browser ${filter:+--color-filter} "$resolved"
      ;;
  esac
  exec "$SCRIPTS_DIR/tmuxy-widget-browser" "$@"
}

# --- Run escape hatch ---

cmd_run() {
  case "${1:-}" in
    --help|-h) usage_run; return ;;
    "") echo "Error: tmux command required" >&2; usage_run >&2; return 1 ;;
  esac

  local tmux_cmd="$1"
  shift

  case "$tmux_cmd" in
    new-window|neww)
      # Intercept: new-window crashes tmux 3.5a with control mode attached.
      # Route splitw+breakp+tag through run-shell as a single atomic tmux
      # command list — the previous implementation ran split-window/break-pane
      # as direct external subprocesses, the exact thing that crashes CC.
      # Mirrors `tmuxy tab create` (cmd_tab).
      echo "Note: new-window intercepted for safety. Using split-window + break-pane." >&2
      local name_arg=""
      while [ $# -gt 0 ]; do
        case "$1" in
          -n) name_arg="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [ -n "$name_arg" ]; then
        _run_safe "splitw \\; breakp -t '#{session_id}:' -n $(shquote "$name_arg")"
      else
        _run_safe "splitw \\; breakp -t '#{session_id}:'"
      fi
      ;;

    resize-window|resizew)
      echo "Error: resize-window is blocked — it is unreliable with control mode attached (ignored when sent externally). Use resize-pane." >&2
      return 1
      ;;

    *)
      _run_safe "$tmux_cmd $(shquote "$@")"
      ;;
  esac
}

# --- Connect to a different tmux server (desktop app) ---

cmd_connect() {
  case "${1:-}" in
    --help|-h) usage_connect; return ;;
    "")
      # No socket given → open the interactive "add a server" form, which the
      # server binary carries. Replaces the current process so it owns the
      # pane (the desktop app runs this in a float); the TUI persists to
      # servers.json and exits.
      find_server_cmd
      exec "${SERVER_CMD[@]}" connect
      ;;
  esac

  local socket="$1"
  local session="${2:-}"

  # Target socket flag: a slash means a full socket path (-S), else a name (-L).
  local target_flag="-L"
  case "$socket" in */*) target_flag="-S" ;; esac

  # Resolve the session when the caller didn't name one: prefer the target
  # server's first existing session, otherwise fall back to `tmuxy` (which the
  # app creates on attach). Querying the target socket directly is read-only
  # and safe even though it's a different server.
  if [ -z "$session" ]; then
    # `|| true` so a missing/empty target server (list-sessions exits non-zero)
    # doesn't trip `set -e`/pipefail; fall back to `tmuxy`.
    # Skip the hidden __tmuxy_stash session (it parks group members and sorts
    # before real sessions, so a naive `head -1` would attach to it).
    session="$(command tmux "$target_flag" "$socket" list-sessions -F '#{session_name}' 2>/dev/null | grep -vFx '__tmuxy_stash' | head -1 || true)"
    [ -z "$session" ] && session="tmuxy"
  fi

  # Publish the request on the CURRENT server via run-shell (control-mode safe).
  # The desktop app's connect watcher reads these and reconnects.
  # Session first, socket last: the desktop app's watcher triggers on
  # TMUXY_CONNECT_TO, so it must be the final write or the poll can fire
  # between the two and reconnect to the default session.
  _run_safe "set-environment -g TMUXY_CONNECT_SESSION $(shquote "$session")"
  _run_safe "set-environment -g TMUXY_CONNECT_TO $(shquote "$socket")"

  echo "Requested desktop app reconnect to socket '$socket' (session '$session')."
  echo "No effect in the web UI — the web server's socket is fixed at launch."
}
