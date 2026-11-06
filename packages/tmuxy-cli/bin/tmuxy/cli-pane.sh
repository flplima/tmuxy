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
        _run_safe "set-option -p -u -t $(shquote "$target") @tmuxy-pane-restore"
      else
        _run_safe "set-option -p -t $(shquote "$target") @tmuxy-pane-restore $(shquote "$value")"
      fi
      _done "paneId=$(json_string "$target")"
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
      # `set-option -p` with no target resolves against tmux's idea of the
      # current pane, which under run-shell is the ACTIVE one, not the caller.
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

# The verbs and their arguments are tmuxy-group's (`packages/tmuxy-group`).
cmd_pane_group() {
  local sub="${1:-}" script=pane-group
  shift 2>/dev/null || true
  case "$sub" in
    --help|-h|"") usage_pane_group; return ;;
    all|ungroup) script=pane-group-tab ;;
    add|close|switch|next|prev|move|join|leave) ;;
    *) _die_usage "Unknown group command: $sub" usage_pane_group ;;
  esac
  case "${1:-}" in
    --help|-h)
      echo "Usage: tmuxy pane group $sub"
      usage_pane_group | awk -v verb="$sub" '$1 == verb'
      return
      ;;
  esac
  # A pane named on the command line is quoted; a default is a bare format,
  # since `shquote` doubles its `#` and would hand the script the text.
  local words=() arg
  for arg in "$@"; do words+=("$(shquote "$arg")"); done
  case "$sub:$#" in
    add:0) words=('#{pane_id}' '#{pane_width}' '#{pane_height}') ;;
    close:0 | next:0 | prev:0 | all:0 | ungroup:0) words=('#{pane_id}') ;;
    switch:0) _die_usage "Usage: tmuxy pane group switch <pane_id>" ;;
    move:[01]) _die_usage "Usage: tmuxy pane group move <%id> <index>" ;;
    join:[01]) _die_usage "Usage: tmuxy pane group join <%id> <%member-or-pane> [index]" ;;
    leave:*)
      local pane_id="${TMUX_PANE:-}"
      case "${1:-}" in %*) pane_id="$1"; shift ;; esac
      [ -n "$pane_id" ] || _die_usage "no pane to take out of its group (pass %id or run inside a pane)"
      words=("$(shquote "$pane_id")" "$(shquote "${1:---tab}")")
      [ $# -lt 2 ] || words+=("$(shquote "$2")" "$(shquote "${3:-right}")")
      ;;
  esac
  _run_shell "bash $(shquote "$SCRIPTS_DIR/$script") $sub ${words[*]}"
  _done
}
