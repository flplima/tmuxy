#!/usr/bin/env bash

_pane_t() {
  PANE_ID="${TMUX_PANE:-}"
  PANE_T="$CALLER_T"
  [ -n "${1:-}" ] || return 0
  PANE_ID="$(_resolve_target "$1")" || exit $?
  PANE_T=" -t $(shquote "$PANE_ID")"
}

# --- Pane subcommands ---

cmd_pane() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    report)
      # A pane's report for whoever started it (docs/SUB-AGENTS.md). Writing
      # is the caller's own pane only, as for restore-cmd; `-t` reads one.
      local target="" text=() own
      while [ $# -gt 0 ]; do
        case "$1" in
          --help|-h)
            echo "Usage: tmuxy pane report <text|->        write this pane's report"
            echo "       tmuxy pane report -t <target>      read a pane's report"
            return
            ;;
          -t) [ -n "${2:-}" ] || _die_usage "-t needs a pane or label"; target="$2"; shift 2 ;;
          *) text+=("$1"); shift ;;
        esac
      done
      find_server_cmd || exit "$EXIT_FAILED"
      if [ -n "$target" ]; then
        [ ${#text[@]} -eq 0 ] || _die_usage "a report is its own pane's to write: -t only reads one"
        target="$(_resolve_target "$target")" || exit $?
        # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
        exec "${SERVER_CMD[@]}" report -t "$target" ${server_json[@]+"${server_json[@]}"}
      fi
      [ ${#text[@]} -eq 1 ] || _die_usage "the report is one argument (quote it), or - for stdin"
      own="$(verified_own_pane "${TMUXY_CALLER_PANE:-}")"
      [ -n "$own" ] || _fail "$EXIT_FAILED" "run this inside the pane the report is about"
      exec "${SERVER_CMD[@]}" report --own "$own" ${server_json[@]+"${server_json[@]}"} -- "${text[0]}"
      ;;

    restore-cmd)
      # Say how to bring this pane back after a restore (`@tmuxy-pane-restore`):
      # the program itself knows (`claude --resume <id>`, `nvim -S`, `ssh
      # host`) where `ps` can only guess. Wins over discovery at restore time.
      local value="" target="" own
      for arg in "$@"; do
        case "$arg" in
          --help|-h)
            echo "Usage: tmuxy pane restore-cmd '<command>' [%id]"
            echo "       tmuxy pane restore-cmd --clear [%id]"
            return
            ;;
          --clear) value="--clear" ;;
          %*) target="$arg" ;;
          *) value="$arg" ;;
        esac
      done
      [ -n "$value" ] || _die_usage "command required (or --clear)"
      # Only the caller's own pane: a restore offers this command in the pane
      # (or runs it, with --run), so setting it on another pane would be
      # typing there without asking.
      own="$(verified_own_pane "${TMUXY_CALLER_PANE:-}")"
      [ -n "$own" ] || _fail "$EXIT_FAILED" "run this inside the pane it is for"
      if [ -n "$target" ] && [ "$target" != "$own" ]; then
        _fail "$EXIT_FAILED" "a pane's restore command is its own to set (you are in $own)"
      fi
      target="$own"

      if [ "$value" = "--clear" ]; then
        _run_safe "set-option -p -u -t $(shquote "$target") $OPT_PANE_RESTORE"
      else
        _run_safe "set-option -p -t $(shquote "$target") $OPT_PANE_RESTORE $(shquote "$value")"
      fi
      _done "paneId=$(json_string "$target")"
      ;;

    state)
      # Declare what this pane is doing, for the sidebar tree to draw. Any
      # process can call it — an agent's hooks, a shell's precmd/preexec, a
      # build script on failure. The words are core's `PaneStateName`, read
      # exactly as written by the UI, the push notification and the screen
      # corrector alike, so a near-miss is refused here instead of reading as
      # `idle` everywhere.
      if [ "${1:-}" = explain ]; then
        shift
        # Where the state came from: Rust reads the pane and the rules.
        local pane="${TMUX_PANE:-}"
        case "${1:-}" in
          --help|-h) echo "Usage: tmuxy pane state explain [target] [--json]"; return ;;
          "") ;;
          *) pane="$(_resolve_target "$1")" || exit $? ;;
        esac
        [ -n "$pane" ] || _die_usage "no pane to explain (pass a target or run inside a pane)"
        find_server_cmd || exit "$EXIT_FAILED"
        # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
        exec "${SERVER_CMD[@]}" state-explain "$pane" ${server_json[@]+"${server_json[@]}"}
      fi
      local value="" target=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h)
            echo "Usage: tmuxy pane state <$PANE_STATE_WORDS|clear> [target]"
            echo "       tmuxy pane state explain [target] [--json]"
            return
            ;;
          *) if [ -z "$value" ]; then value="$arg"; else target="$arg"; fi ;;
        esac
      done
      [ -n "$value" ] || _die_usage "state value required"
      local word known=false
      for word in ${PANE_STATE_WORDS//|/ } clear; do
        [ "$value" != "$word" ] || known=true
      done
      $known || _die_usage "unknown pane state '$value' (one of: ${PANE_STATE_WORDS//|/, }, clear)"
      # `set-option -p` with no target resolves against tmux's idea of the
      # current pane, which under run-shell is the ACTIVE one, not the caller.
      if [ -n "$target" ]; then
        target="$(_resolve_target "$target")" || exit $?
      else
        target="${TMUX_PANE:-}"
      fi
      [ -n "$target" ] || _die_usage "no pane to target (pass a target or run inside a pane)"
      if [ "$value" = clear ]; then
        _run_safe "set-option -p -u -t $(shquote "$target") $OPT_PANE_STATE"
      else
        _run_safe "set-option -p -t $(shquote "$target") $OPT_PANE_STATE $(shquote "$value")"
      fi
      _done "paneId=$(json_string "$target")" "state=$(json_string "$value")"
      ;;

    list)
      local all=false
      for arg in "$@"; do
        case "$arg" in
          --all) all=true ;;
          --help|-h) echo "Usage: tmuxy pane list [--json] [--all]"; return ;;
          *) _die_usage "invalid argument '$arg'. Use --all or --json" ;;
        esac
      done
      # The caller's tab, not the active one: a target-less `list-panes`
      # from the CLI's client lists the session's current window.
      local scope=(${TMUX_PANE:+-t "$TMUX_PANE"})
      if $all; then scope=(-s); fi
      if [ "$JSON_OUT" = true ]; then
        local rows
        rows=$(_tmux_read list-panes ${scope[@]+"${scope[@]}"} -F "$LIST_PANES_JSON_FMT") || exit $?
        printf '%s\n' "$rows" | \
          awk -F'\t' "$JSON_AWK"'BEGIN{printf "["} NF==0{next} n++{printf ","} {printf "{\"id\":\"%s\",\"tab\":\"%s\",\"width\":%s,\"height\":%s,\"command\":\"%s\",\"active\":%s,\"title\":\"%s\",\"label\":\"%s\"}", jstr($1), jstr($2), $3, $4, jstr($5), ($6=="1"?"true":"false"), jstr($7), jstr($8)} END{printf "]\n"}'
      else
        _tmux_read list-panes ${scope[@]+"${scope[@]}"}
      fi
      ;;

    split)
      # `-h` is this command's own flag (horizontal split), so only the long
      # form asks for help — otherwise `tmuxy pane split -h` prints usage
      # instead of splitting.
      local args=""
      for arg in "$@"; do
        case "$arg" in
          --help) echo "Usage: tmuxy pane split [-h|-v] [--json]"; return ;;
          -h|-v) args="$args $arg" ;;
          # Spliced into the command line: anything else could be a command
          # for the new pane, or a `;` and a command of its own.
          *) _die_usage "invalid argument '$arg'. Use -h, -v or --json" ;;
        esac
      done
      local out
      out=$(_run_safe "splitw$args$CALLER_T -P -F '##{pane_id}'")
      local pane_id
      pane_id=$(echo "$out" | grep -o '%[0-9]*' | tail -1 || true)
      if [ "$JSON_OUT" = true ]; then
        printf '{"ok":true,"paneId":"%s"}\n' "${pane_id:-}"
      elif [ -n "$pane_id" ]; then
        echo "$pane_id"
      fi
      ;;

    kill)
      local target=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy pane kill [target]"; return ;;
          *) target="$arg" ;;
        esac
      done
      _pane_t "$target"
      _run_safe "killp$PANE_T"
      _done "paneId=$(json_string "$PANE_ID")"
      ;;

    select)
      local arg="${1:-}"
      case "$arg" in
        --help|-h) echo "Usage: tmuxy pane select [-U|-D|-L|-R|target]"; return ;;
        -U|-D|-L|-R) _run_safe "selectp $arg$CALLER_T"; _done "direction=$(json_string "$arg")" ;;
        "") _die_usage "pane direction or target required" ;;
        -*) _die_usage "invalid argument '$arg'. Use -U, -D, -L, -R, or a target" ;;
        *)
          _pane_t "$arg"
          _run_safe "selectp$PANE_T"
          _done "paneId=$(json_string "$PANE_ID")"
          ;;
      esac
      ;;

    resize)
      local args=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy pane resize [-U|-D|-L|-R] [n]"; return ;;
          -U|-D|-L|-R) args="$args $arg" ;;
          *[!0-9]*|"") _die_usage "invalid argument '$arg'. Use -U, -D, -L, -R and a number" ;;
          *) args="$args $arg" ;;
        esac
      done
      [ -n "$args" ] || _die_usage "direction required (-U, -D, -L, -R)"
      _run_safe "resizep$CALLER_T$args"
      _done
      ;;

    swap)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane swap <src> <dst>"; return ;;
      esac
      [ -n "${1:-}" ] && [ -n "${2:-}" ] || _die_usage "Usage: tmuxy pane swap <src> <dst>"
      local src dst
      src="$(_resolve_target "$1")" || exit $?
      dst="$(_resolve_target "$2")" || exit $?
      _run_safe "swap-pane -s $(shquote "$src") -t $(shquote "$dst")"
      _done "src=$(json_string "$src")" "dst=$(json_string "$dst")"
      ;;

    zoom)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane zoom"; return ;;
      esac
      _run_safe "resizep -Z$CALLER_T"
      _done
      ;;

    break)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane break"; return ;;
      esac
      local out tab_id
      out=$(_run_safe "breakp${CALLER_T/ -t / -s } -t '#{session_id}:' -P -F '##{window_id}'")
      tab_id=$(echo "$out" | grep -o '@[0-9]*' | tail -1 || true)
      if [ "$JSON_OUT" = true ]; then
        printf '{"ok":true,"tabId":"%s"}\n' "${tab_id:-}"
      elif [ -n "$tab_id" ]; then
        echo "$tab_id"
      fi
      ;;

    run|wait|capture)
      "cmd_pane_$sub" "$@"
      ;;

    send)
      [ -n "${1:-}" ] || _die_usage "keys required"
      JSON_OUT="$JSON_OUT" exec bash "$SCRIPTS_DIR/send" "$@"
      ;;

    paste)
      local target=()
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane paste [-t <target>] <text>"; return ;;
        -t) target=(-t "${2:?-t needs a pane}"); shift 2 ;;
      esac
      [ -n "${1:-}" ] || _die_usage "text required"
      # Through `send`, so a paste follows its rules: without the controls
      # that could end a bracketed paste early, into the caller's own pane at
      # once, into any other only once the user allows it there.
      JSON_OUT="$JSON_OUT" exec bash "$SCRIPTS_DIR/send" --paste ${target[@]+"${target[@]}"} -- "$*"
      ;;

    float)
      case "${1:-}" in
        --help|-h) cat <<'FEOF'
Usage: tmuxy pane float [options] [cmd args...]

Options:
  --left          Drawer docked to left edge
  --right         Drawer docked to right edge
  --top           Drawer docked to top edge
  --bottom        Drawer docked to bottom edge
  --width N       Width in columns, default 60 (a top/bottom drawer spans the
                  full width, so it ignores this)
  --height N      Height in rows, default 15 and never more than the tab's own
                  height (a left/right drawer spans the full height, so it
                  ignores this)
  --bg MODE       Backdrop: dim (default), blur, none
  --hide-header   Hide the title bar
  --detach        With a command: print the float's pane id at once instead
                  of waiting for the command and printing its output
FEOF
          return ;;
      esac
      JSON_OUT=$JSON_OUT exec bash "$SCRIPTS_DIR/float-create" "$@"
      ;;

    group)
      cmd_pane_group "$@"
      ;;

    --help|-h|"")
      usage_pane
      ;;

    *)
      _die_usage "Unknown pane command: $sub" usage_pane
      ;;
  esac
}

# --- Pane group subcommands ---

# The verbs, their arguments, their defaults and their help are the `group`
# verb's (`packages/tmuxy-verbs/src/group_cli.rs`): this forwards them to the
# pane-group script inside run-shell, and the verb answers.
cmd_pane_group() {
  local arg words=()
  for arg in "$@"; do
    case "$arg" in
      --help | -h)
        find_server_cmd || exit 1
        exec "${SERVER_CMD[@]}" group "$@"
        ;;
    esac
    words+=("$(shquote "$arg")")
  done
  if [ $# -eq 0 ]; then
    find_server_cmd || exit 1
    exec "${SERVER_CMD[@]}" group --help
  fi
  _run_as_caller "bash $(shquote "$SCRIPTS_DIR/pane-group") ${words[*]}$(_json_flag)"
}
