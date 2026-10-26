#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — tab, widget, session, nav, run and connect subcommands.

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
    tree)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy widget tree"; return ;;
      esac
      exec "$SCRIPTS_DIR/tmuxy-widget-tree"
      ;;

    preview)
      exec "$SCRIPTS_DIR/tmuxy-widget-preview" "$@"
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
      # `--run` starts every pane's saved command without offering it first.
      # A person at a terminal can say so; a script or an agent, with no
      # terminal, gets the restore with each command offered instead.
      local quoted="" arg
      for arg in "$@"; do
        if [ "$arg" = "--run" ] && ! [ -t 0 ]; then
          echo "Error: --run needs a terminal; without it each command is offered in its pane" >&2
          return 1
        fi
        quoted="$quoted $(shquote "$arg")"
      done
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

# --- Run escape hatch ---

# Whether `word` names one of `names` the way tmux reads a command name: the
# name or its alias exactly, or a prefix of the name (tmux takes a unique one).
# `set` and `show` are aliases of their own, never prefixes of the others.
_names_command() {
  local word="$1" name
  shift
  for name in "$@"; do
    [ "$word" = "$name" ] && return 0
    case "$word" in set|setw|show|showw) continue ;; esac
    [ "${#word}" -ge 2 ] && [ "${name#"$word"}" != "$name" ] && [[ "$name" == *-* ]] && return 0
  done
  return 1
}

# The pane `-t` names in a tmux command's arguments (`-t %3`, `-t%3`, or the
# last flag of a cluster, `-lt %3`); empty when there is none.
_target_of() {
  local arg rest
  while [ $# -gt 0 ]; do
    arg="$1"
    shift
    case "$arg" in
      --) break ;;
      -*)
        rest="${arg#-}"
        case "$rest" in
          *t*)
            rest="${rest#*t}"
            if [ -n "$rest" ]; then printf '%s' "$rest"; else printf '%s' "${1:-}"; fi
            return
            ;;
        esac
        ;;
    esac
  done
}

# What `tmuxy run` will not do, as the reason it says so; nothing when the
# command may run. The send question (`tmuxy pane send -t`) is how another
# pane is typed into, and this is the one other door to tmux the CLI has.
_run_refusal() {
  local verb="$1"
  shift
  if _names_command "$verb" send-keys send send-prefix paste-buffer pasteb pipe-pane pipep; then
    local target own
    target="$(_target_of "$@")"
    own="$(verified_own_pane "${TMUXY_CALLER_PANE:-}")"
    if [ -z "$own" ] || { [ -n "$target" ] && [ "$target" != "$own" ]; }; then
      echo "input into another pane goes through \`tmuxy pane send -t <pane>\`, which asks the user"
    fi
    return
  fi
  if _names_command "$verb" run-shell run if-shell if respawn-pane respawnp respawn-window respawnw \
    set-environment setenv set-hook source-file source; then
    echo "$verb runs a shell or changes what one runs"
    return
  fi
  if _names_command "$verb" set-option set set-window-option setw; then
    local arg
    for arg in "$@"; do
      case "$arg" in
        @tmuxy-ask* | @tmuxy-send-* | @tmuxy-pane-restore)
          echo "$arg belongs to the send question and the client that answers it"
          return
          ;;
      esac
    done
  fi
}

cmd_run() {
  case "${1:-}" in
    --help|-h) usage_run; return ;;
    "") echo "Error: tmux command required" >&2; usage_run >&2; return 1 ;;
  esac

  local tmux_cmd="$1"
  shift

  # The first argument is spliced into the line run-shell hands a shell. It
  # may be a whole command (`tmuxy run 'list-sessions -F "#{session_name}"'`),
  # whose quotes that shell then reads, but never shell syntax of its own: no
  # `;` to chain another command, no `$(…)`, no redirection.
  local words=() word
  if [[ "$tmux_cmd" == *[[:space:]]* ]]; then
    local syntax='[;|&$`<>()\\]'
    if [[ "$tmux_cmd" =~ $syntax ]] || [[ "$tmux_cmd" == *$'\n'* ]]; then
      echo "Error: refused: '$tmux_cmd' holds shell syntax; pass the command's words as arguments" >&2
      return 1
    fi
    # Its words as that shell will split them, for the checks below.
    while IFS= read -r -d '' word; do words+=("$word"); done < <(printf '%s' "$tmux_cmd" | xargs printf '%s\0')
  else
    words=("$tmux_cmd")
  fi
  # The command name is one word of a command name and nothing else.
  if ! [[ "${words[0]:-}" =~ ^[a-z][a-z-]*$ ]]; then
    echo "Error: '$tmux_cmd' is not a tmux command name" >&2
    return 1
  fi
  local refusal
  refusal="$(_run_refusal "${words[@]}" "$@")"
  if [ -n "$refusal" ]; then
    echo "Error: refused: $refusal" >&2
    return 1
  fi

  case "${words[0]}" in
    new-window|neww)
      # Intercept: new-window crashes tmux 3.5a with control mode attached.
      # `tmuxy tab create` is the one place that knows the safe shape (splitw
      # + breakp, one run-shell); this keeps only the flag it takes.
      echo "Note: new-window intercepted for safety. Using split-window + break-pane." >&2
      local name_arg=""
      while [ $# -gt 0 ]; do
        case "$1" in
          -n) name_arg="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      cmd_tab create ${name_arg:+"$name_arg"}
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
      # No socket given → the connect flow, `tmuxy session connect`: it asks
      # for a destination, probes it, saves it to servers.json and attaches.
      exec bash "$SCRIPTS_DIR/session-connect"
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
