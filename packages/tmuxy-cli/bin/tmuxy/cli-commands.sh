#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — tab, widget, session, nav, run and connect subcommands.

# A tab to act on: an `@id`, an index or a `session:window` target is handed
# back as written; anything else is a tab NAME, which must name exactly one
# window (exit 3 otherwise, with nothing changed).
# Args: $1=target
_resolve_tab() {
  local target="$1" rows matches count
  case "$target" in
    @[0-9]* | [0-9]* | \$[0-9]* | %[0-9]* | *:* | '{'*) printf '%s' "$target"; return 0 ;;
  esac
  rows="$(_tmux_read list-windows -a -F $'#{window_id}\t#{window_name}\t#{session_name}' 2>/dev/null || true)"
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

# The tab a command acts on: TAB_ID the one named (`_resolve_tab`), else
# empty; TAB_T the matching `-t` clause, which is the caller's own window
# (through its pane id, `CALLER_T`) when none is named.
# Args: $1=target as written (may be empty)
_tab_t() {
  TAB_ID=""
  TAB_T="$CALLER_T"
  [ -n "${1:-}" ] || return 0
  TAB_ID="$(_resolve_tab "$1")" || exit $?
  TAB_T=" -t $(shquote "$TAB_ID")"
}

# A mutation's answer: the JSON object under `--json`, else nothing.
_done() {
  [ "$JSON_OUT" = true ] || return 0
  json_ok "$@"
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
        # Include @tmuxy-window-type ($6) so we can drop tmuxy's hidden windows
        # (floats and the sidebars). Keep "tab" and untagged/foreign ("")
        # windows so this still works in a plain (non-tmuxy) session.
        # Tab-separated: window_name is user-controlled free text (tmuxy tab
        # rename), so a comma in it would shift every following field.
        local rows
        rows=$(_tmux_read list-windows -F "$LIST_WINDOWS_JSON_FMT") || exit $?
        printf '%s\n' "$rows" | \
          awk -F'\t' "$JSON_ESCAPE_AWK"'BEGIN{printf "["; n=0} NF>0 && $6!="float" && $6!~/^sidebar-/{ if(n++) printf ","; printf "{\"id\":\"%s\",\"index\":%s,\"name\":\"%s\",\"panes\":%s,\"active\":%s}", jstr($1), $2, jstr($3), $4, ($5=="1"?"true":"false")} END{printf "]\n"}'
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
        out=$(_run_safe "splitw$CALLER_T \\; breakp -t '#{session_id}:' -n $(shquote "$name") -P -F '##{window_id}'")
      else
        out=$(_run_safe "splitw$CALLER_T \\; breakp -t '#{session_id}:' -P -F '##{window_id}'")
      fi
      local tab_id
      tab_id=$(echo "$out" | grep -o '@[0-9]*' | tail -1 || true)
      if [ "$JSON_OUT" = true ]; then
        printf '{"ok":true,"tabId":"%s"}\n' "${tab_id:-}"
      elif [ -n "$tab_id" ]; then
        echo "$tab_id"
      fi
      ;;

    kill)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy tab kill [target]"; return ;;
      esac
      _tab_t "${1:-}"
      _run_safe "killw$TAB_T"
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
      exec "$SCRIPTS_DIR/tmuxy-widget-preview" "$@"
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
      case "${1:-}" in
        --help|-h) exec bash "$SCRIPTS_DIR/session-connect" --help ;;
      esac
      exec bash "$SCRIPTS_DIR/session-connect" "$@"
      ;;

    save|snapshots)
      # Reads only (tmux queries and `ps`), safe as a plain subprocess.
      find_server_cmd
      [ "$JSON_OUT" = true ] || exec "${SERVER_CMD[@]}" session "$sub" "$@"
      local out status=0
      out=$("${SERVER_CMD[@]}" session "$sub" "$@") || status=$?
      [ "$status" -eq 0 ] || _fail "$status" "$out"
      if [ "$sub" = snapshots ]; then
        # The binary prints one `name<TAB>saved<TAB>state` per line.
        printf '%s\n' "$out" | awk -F'\t' "$JSON_ESCAPE_AWK"'BEGIN{printf "["} NF>0{ if(n++) printf ","; printf "{\"name\":\"%s\",\"saved\":\"%s\",\"state\":\"%s\"}", jstr($1), jstr($2), jstr($3)} END{printf "]\n"}'
      else
        json_ok "output=$(json_string "$out")"
      fi
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
          _fail "$EXIT_USAGE" "--run needs a terminal; without it each command is offered in its pane"
        fi
        quoted="$quoted $(shquote "$arg")"
      done
      find_server_cmd
      _run_shell "$(shquote "${SERVER_CMD[@]}") session restore$quoted"
      _done
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
      _done
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
    "") _die_usage "tmux command required" usage_run ;;
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
      _fail "$EXIT_FAILED" "refused: '$tmux_cmd' holds shell syntax; pass the command's words as arguments"
    fi
    # Its words as that shell will split them, for the checks below.
    while IFS= read -r -d '' word; do words+=("$word"); done < <(printf '%s' "$tmux_cmd" | xargs printf '%s\0')
  else
    words=("$tmux_cmd")
  fi
  # The command name is one word of a command name and nothing else.
  if ! [[ "${words[0]:-}" =~ ^[a-z][a-z-]*$ ]]; then
    _die_usage "'$tmux_cmd' is not a tmux command name"
  fi
  local refusal
  refusal="$(_run_refusal "${words[@]}" "$@")"
  if [ -n "$refusal" ]; then
    _fail "$EXIT_FAILED" "refused: $refusal"
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
      _fail "$EXIT_FAILED" "resize-window is blocked — it is unreliable with control mode attached (ignored when sent externally). Use resize-pane."
      ;;

    *)
      if [ "$JSON_OUT" = true ]; then
        # The command's output and status as one object: what tmux printed
        # is a string, and a failure is `ok:false` with the exit code it had.
        local out status=0
        out=$(_run_safe "$tmux_cmd $(shquote "$@")") || status=$?
        local ok=true
        [ "$status" -eq 0 ] || ok=false
        printf '{"ok":%s,"status":%s,"stdout":%s}\n' "$ok" "$status" "$(json_string "$out")"
        return "$status"
      fi
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

  if [ "$JSON_OUT" = true ]; then
    json_ok "socket=$(json_string "$socket")" "session=$(json_string "$session")"
    return 0
  fi
  echo "Requested desktop app reconnect to socket '$socket' (session '$session')."
  echo "No effect in the web UI — the web server's socket is fixed at launch."
}
