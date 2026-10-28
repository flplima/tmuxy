#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — pane and pane-group subcommands.
# `pane run`, `pane wait` and `pane capture` are in cli-pane-run.sh.

# The pane a command acts on: PANE_ID is the target named (a pane id or a
# label, `_resolve_target`), else the caller's own pane; PANE_T the same as a
# `-t` clause for the command line (empty when no pane is known — tmux's own
# default). A label that resolves to nothing or to several panes ends the
# command here, before anything has changed.
# Args: $1=target as written (may be empty)
_pane_t() {
  PANE_ID="${TMUX_PANE:-}"
  PANE_T="$CALLER_T"
  [ -n "${1:-}" ] || return 0
  PANE_ID="$(_resolve_target "$1")" || exit $?
  PANE_T=" -t $(shquote "$PANE_ID")"
}

# A mutation's answer: the JSON object under `--json`, else nothing.
_pane_done() {
  [ "$JSON_OUT" = true ] || return 0
  json_ok "$@"
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
        _run_safe "set-option -p -u -t $(shquote "$target") @tmuxy-pane-restore"
      else
        _run_safe "set-option -p -t $(shquote "$target") @tmuxy-pane-restore $(shquote "$value")"
      fi
      _pane_done "paneId=$(json_string "$target")"
      ;;

    state)
      # Declare what this pane is doing, for the sidebar tree to draw. Any
      # process can call it — an agent's hooks, a shell's precmd/preexec, a
      # build script on failure — which is why the value is not validated
      # here: the client owns the vocabulary and collapses what it doesn't
      # know, so a writer is free to use its own names.
      local value="" target=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h)
            echo "Usage: tmuxy pane state <idle|working|needs-input|error|unread|clear> [target]"
            return
            ;;
          *) if [ -z "$value" ]; then value="$arg"; else target="$arg"; fi ;;
        esac
      done
      [ -n "$value" ] || _die_usage "state value required"
      # Default to the calling pane. `set-option -p` with no target resolves
      # against tmux's idea of the current pane, which under run-shell is the
      # ACTIVE one, not the caller — so the target is always explicit.
      if [ -n "$target" ]; then
        target="$(_resolve_target "$target")" || exit $?
      else
        target="${TMUX_PANE:-}"
      fi
      [ -n "$target" ] || _die_usage "no pane to target (pass a target or run inside a pane)"
      if [ "$value" = clear ]; then
        _run_safe "set-option -p -u -t $(shquote "$target") @tmuxy-pane-state"
      else
        _run_safe "set-option -p -t $(shquote "$target") @tmuxy-pane-state $(shquote "$value")"
      fi
      _pane_done "paneId=$(json_string "$target")" "state=$(json_string "$value")"
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
        # Tab-separated: pane_current_command is free text, so a comma in it
        # would shift every following field and break the JSON.
        local rows
        rows=$(_tmux_read list-panes ${scope[@]+"${scope[@]}"} -F "$LIST_PANES_JSON_FMT") || exit $?
        printf '%s\n' "$rows" | \
          awk -F'\t' "$JSON_ESCAPE_AWK"'BEGIN{printf "["} NF==0{next} n++{printf ","} {printf "{\"id\":\"%s\",\"tab\":\"%s\",\"width\":%s,\"height\":%s,\"command\":\"%s\",\"active\":%s,\"title\":\"%s\",\"label\":\"%s\"}", jstr($1), jstr($2), $3, $4, jstr($5), ($6=="1"?"true":"false"), jstr($7), jstr($8)} END{printf "]\n"}'
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
      _pane_done "paneId=$(json_string "$PANE_ID")"
      ;;

    select)
      local arg="${1:-}"
      case "$arg" in
        --help|-h) echo "Usage: tmuxy pane select [-U|-D|-L|-R|target]"; return ;;
        -U|-D|-L|-R) _run_safe "selectp $arg$CALLER_T"; _pane_done "direction=$(json_string "$arg")" ;;
        "") _die_usage "pane direction or target required" ;;
        -*) _die_usage "invalid argument '$arg'. Use -U, -D, -L, -R, or a target" ;;
        *)
          _pane_t "$arg"
          _run_safe "selectp$PANE_T"
          _pane_done "paneId=$(json_string "$PANE_ID")"
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
      _pane_done
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
      _pane_done "src=$(json_string "$src")" "dst=$(json_string "$dst")"
      ;;

    zoom)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane zoom"; return ;;
      esac
      _run_safe "resizep -Z$CALLER_T"
      _pane_done
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
      JSON_OUT="$JSON_OUT" bash "$SCRIPTS_DIR/send" "$@"
      ;;

    paste)
      local target=()
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane paste [-t <target>] <text>"; return ;;
        -t) target=(-t "${2:?-t needs a pane}"); shift 2 ;;
      esac
      [ -n "${1:-}" ] || _die_usage "text required"
      # The markers that open and close a bracketed paste are the terminal's
      # to send: one inside the text would end the paste early and run what
      # follows it. Stripped until none is left, since removing one can join
      # the halves of another.
      local text="$*" start=$'\e[200~' end=$'\e[201~' before
      while :; do
        before="$text"
        text="${text//"$start"/}"
        text="${text//"$end"/}"
        [ "$text" = "$before" ] && break
      done
      # Through `send`, so a paste follows its rules: into the caller's own
      # pane at once, into any other only once the user allows it there.
      JSON_OUT="$JSON_OUT" bash "$SCRIPTS_DIR/send" --paste ${target[@]+"${target[@]}"} -- "$text"
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
FEOF
          return ;;
      esac
      exec bash "$SCRIPTS_DIR/float-create" "$@"
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

cmd_pane_group() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    add)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group add"; return ;;
      esac
      _run_shell "bash '$SCRIPTS_DIR/pane-group' add #{pane_id} #{pane_width} #{pane_height}"
      _pane_done
      ;;

    close)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group close [%id]"; return ;;
      esac
      # The default stays a bare format for run-shell to expand; `shquote`
      # doubles its `#`, which would hand the script the text instead.
      local target='#{pane_id}'
      [ -z "${1:-}" ] || target="$(shquote "$1")"
      _run_shell "bash '$SCRIPTS_DIR/pane-group' close $target"
      _pane_done
      ;;

    switch)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group switch <%id>"; return ;;
      esac
      [ -n "${1:-}" ] || _die_usage "Usage: tmuxy pane group switch <pane_id>"
      _run_shell "bash '$SCRIPTS_DIR/pane-group' switch $(shquote "$1")"
      _pane_done
      ;;

    move)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group move <%id> <index>   (0 is first)"; return ;;
      esac
      [ -n "${1:-}" ] && [ -n "${2:-}" ] || _die_usage "Usage: tmuxy pane group move <%id> <index>"
      _run_shell "bash '$SCRIPTS_DIR/pane-group' move $(shquote "$1") $(shquote "$2")"
      _pane_done
      ;;

    join)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group join <%id> <%member-or-pane> [index]"; return ;;
      esac
      [ -n "${1:-}" ] && [ -n "${2:-}" ] || _die_usage "Usage: tmuxy pane group join <%id> <%member-or-pane> [index]"
      _run_shell "bash '$SCRIPTS_DIR/pane-group' join $(shquote "$1") $(shquote "$2") $(shquote "${3:-}")"
      _pane_done
      ;;

    leave)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group leave [%id] [--tab | --beside <%id> <left|right|up|down>]"; return ;;
      esac
      local pane_id="${TMUX_PANE:-}"
      case "${1:-}" in %*) pane_id="$1"; shift ;; esac
      [ -n "$pane_id" ] || _die_usage "no pane to take out of its group (pass %id or run inside a pane)"
      local mode="${1:---tab}" beside="${2:-}" dir="${3:-right}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group' leave $(shquote "$pane_id") $(shquote "$mode") $(shquote "$beside") $(shquote "$dir")"
      _pane_done
      ;;

    next|prev)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group $sub"; return ;;
      esac
      _run_shell "bash '$SCRIPTS_DIR/pane-group' $sub #{pane_id}"
      _pane_done
      ;;

    --help|-h|"")
      usage_pane_group
      ;;

    *)
      _die_usage "Unknown group command: $sub" usage_pane_group
      ;;
  esac
}
