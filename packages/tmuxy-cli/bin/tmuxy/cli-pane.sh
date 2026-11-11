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
      local value="" target=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h)
            echo "Usage: tmuxy pane state <$PANE_STATE_WORDS|clear> [target]"
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

    meta)
      cmd_pane_meta "$@"
      ;;

    --help|-h|"")
      usage_pane
      ;;

    *)
      _die_usage "Unknown pane command: $sub" usage_pane
      ;;
  esac
}

# --- Pane meta ---

usage_pane_meta() {
  cat <<'EOF'
Usage: tmuxy pane meta set [-t target] [--ttl 5m] key=value...
       tmuxy pane meta unset [-t target] key...
       tmuxy pane meta list [-t target]
       tmuxy pane meta clear [-t target]

Short fields a script or an agent sets on a pane, for its row in the sidebar
tree: `tmuxy pane meta set ci=passing`. A key is a lowercase letter, then up
to 23 of a-z 0-9 - _; a value is one line of up to 80 characters. A pane
holds up to 8. With --ttl (30s, 5m, 2h, 1d) a field is shown for that long.
Without -t, the pane you run it in.
EOF
}

# The fields' rules, their storage and the answers are the `meta` verb's
# (`packages/tmuxy-verbs/src/meta_cli.rs`): this resolves the pane.
cmd_pane_meta() {
  local action="${1:-}" pane="" ttl="" pairs=() rc=0 resolved
  case "$action" in
    set | unset | list | clear) shift ;;
    "" | --help | -h)
      usage_pane_meta
      return
      ;;
    *) _die_usage "unknown pane meta action '$action' (set, unset, list, clear)" usage_pane_meta ;;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in
      -t)
        pane="${2:?-t needs a pane}"
        shift 2
        ;;
      -t*)
        pane="${1#-t}"
        shift
        ;;
      --ttl)
        ttl="${2:?--ttl needs a time, like 5m}"
        shift 2
        ;;
      --help | -h)
        usage_pane_meta
        return
        ;;
      -*) _die_usage "unknown option '$1'" usage_pane_meta ;;
      *)
        pairs+=("$1")
        shift
        ;;
    esac
  done
  [ "$action" = set ] || [ -z "$ttl" ] || _die_usage "--ttl goes with set"
  pane="${pane:-${TMUX_PANE:-}}"
  [ -n "$pane" ] || _die_usage "no pane to work on (pass -t)"
  pane="$(_resolve_target "$pane")" || exit $?
  resolved="$(_tmux_read display-message -p -t "$pane" '#{pane_id}' 2>/dev/null)" || rc=$?
  _exit_if_no_server "$rc"
  [ "$rc" -eq 0 ] || _fail "$EXIT_TARGET" "no such pane: $pane"
  [ -n "$resolved" ] && pane="$resolved"
  find_server_cmd || exit "$EXIT_FAILED"
  local verb=(meta --target "$pane")
  [ "$JSON_OUT" = true ] && verb+=(--json)
  verb+=("$action")
  [ -n "$ttl" ] && verb+=(--ttl "$ttl")
  exec "${SERVER_CMD[@]}" "${verb[@]}" -- ${pairs[@]+"${pairs[@]}"}
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
