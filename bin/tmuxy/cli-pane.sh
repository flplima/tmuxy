#!/usr/bin/env bash
# Sourced by bin/tmuxy-cli — pane and pane-group subcommands.

# --- Pane subcommands ---

cmd_pane() {
  local sub="${1:-}"
  shift 2>/dev/null || true

  case "$sub" in
    restore-cmd)
      # Say how to bring this pane back after a restore (`@tmuxy-pane-restore`):
      # the program itself knows (`claude --resume <id>`, `nvim -S`, `ssh
      # host`) where `ps` can only guess. Wins over discovery at restore time.
      local value="" target=""
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
      if [ -z "$value" ]; then
        echo "Error: command required (or --clear)" >&2
        return 1
      fi
      target="${target:-${TMUX_PANE:-}}"
      if [ -z "$target" ]; then
        echo "Error: no pane to target (pass %id or run inside a pane)" >&2
        return 1
      fi
      if [ "$value" = "--clear" ]; then
        _run_safe "set-option -p -u -t $(shquote "$target") @tmuxy-pane-restore"
      else
        _run_safe "set-option -p -t $(shquote "$target") @tmuxy-pane-restore $(shquote "$value")"
      fi
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
            echo "Usage: tmuxy pane state <idle|working|needs-input|error|unread|clear> [%id]"
            return
            ;;
          %*) target="$arg" ;;
          *) value="$arg" ;;
        esac
      done
      if [ -z "$value" ]; then
        echo "Error: state value required" >&2
        return 1
      fi
      # Default to the calling pane. `set-option -p` with no target resolves
      # against tmux's idea of the current pane, which under run-shell is the
      # ACTIVE one, not the caller — so the target is always explicit.
      target="${target:-${TMUX_PANE:-}}"
      if [ -z "$target" ]; then
        echo "Error: no pane to target (pass %id or run inside a pane)" >&2
        return 1
      fi
      if [ "$value" = clear ]; then
        _run_safe "set-option -p -u -t $(shquote "$target") @tmuxy-pane-state"
      else
        _run_safe "set-option -p -t $(shquote "$target") @tmuxy-pane-state $(shquote "$value")"
      fi
      ;;

    list)
      local json=false all=false
      for arg in "$@"; do
        case "$arg" in
          --json) json=true ;;
          --all) all=true ;;
          --help|-h) echo "Usage: tmuxy pane list [--json] [--all]"; return ;;
        esac
      done
      local scope=()
      if $all; then scope=(-s); fi
      if $json; then
        # Tab-separated: pane_current_command is free text, so a comma in it
        # would shift every following field and break the JSON.
        _tmux list-panes ${scope[@]+"${scope[@]}"} -F "$LIST_PANES_JSON_FMT" | \
          awk -F'\t' "$JSON_ESCAPE_AWK"'BEGIN{printf "["} NR>1{printf ","} {printf "{\"id\":\"%s\",\"tab\":\"%s\",\"width\":%s,\"height\":%s,\"command\":\"%s\",\"active\":%s,\"title\":\"%s\"}", jstr($1), jstr($2), $3, $4, jstr($5), ($6=="1"?"true":"false"), jstr($7)} END{printf "]\n"}'
      else
        _tmux list-panes ${scope[@]+"${scope[@]}"}
      fi
      ;;

    split)
      # `-h` is this command's own flag (horizontal split), so only the long
      # form asks for help — otherwise `tmuxy pane split -h` prints usage
      # instead of splitting.
      local args="" json=false
      for arg in "$@"; do
        case "$arg" in
          --help) echo "Usage: tmuxy pane split [-h|-v] [--json]"; return ;;
          --json) json=true ;;
          *) args="$args $arg" ;;
        esac
      done
      local out
      out=$(_run_safe "splitw$args -P -F '##{pane_id}'")
      local pane_id
      pane_id=$(echo "$out" | grep -o '%[0-9]*' | tail -1 || true)
      if $json; then
        printf '{"paneId":"%s"}\n' "${pane_id:-}"
      elif [ -n "$pane_id" ]; then
        echo "$pane_id"
      fi
      ;;

    kill)
      local target=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy pane kill [%id]"; return ;;
          *) target="$arg" ;;
        esac
      done
      if [ -n "$target" ]; then
        _run_safe "killp -t $(shquote "$target")"
      else
        _run_safe "killp"
      fi
      ;;

    select)
      local arg="${1:-}"
      case "$arg" in
        --help|-h) echo "Usage: tmuxy pane select [-U|-D|-L|-R|%id]"; return ;;
        -U|-D|-L|-R) _run_safe "selectp $arg" ;;
        %*) _run_safe "selectp -t $(shquote "$arg")" ;;
        "") echo "Error: pane direction or ID required" >&2; return 1 ;;
        *) echo "Error: invalid argument '$arg'. Use -U, -D, -L, -R, or %id" >&2; return 1 ;;
      esac
      ;;

    resize)
      local args=""
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy pane resize [-U|-D|-L|-R] [n]"; return ;;
          *) args="$args $arg" ;;
        esac
      done
      if [ -z "$args" ]; then
        echo "Error: direction required (-U, -D, -L, -R)" >&2; return 1
      fi
      _run_safe "resizep$args"
      ;;

    swap)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane swap <src> <dst>"; return ;;
      esac
      local src="${1:?Usage: tmuxy pane swap <src> <dst>}"
      local dst="${2:?Usage: tmuxy pane swap <src> <dst>}"
      _run_safe "swap-pane -s $(shquote "$src") -t $(shquote "$dst")"
      ;;

    zoom)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane zoom"; return ;;
      esac
      _run_safe "resizep -Z"
      ;;

    break)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane break"; return ;;
      esac
      _run_safe "breakp -t '#{session_id}:'"
      ;;

    capture)
      local target="" json=false
      for arg in "$@"; do
        case "$arg" in
          --help|-h) echo "Usage: tmuxy pane capture [%id] [--json]"; return ;;
          --json) json=true ;;
          %*) target="$arg" ;;
        esac
      done
      local cmd="capture-pane -p"
      if [ -n "$target" ]; then cmd="$cmd -t $target"; fi
      local content
      content=$(_tmux $cmd)
      if $json; then
        # Escape for JSON: backslash, double-quote, then convert newlines
        local escaped
        escaped=$(printf '%s' "$content" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{if(NR>1)printf "\\n"; printf "%s",$0}')
        printf '{"content":"%s"}\n' "$escaped"
      else
        echo "$content"
      fi
      ;;

    send)
      case "${1:-}" in
        "") echo "Error: keys required" >&2; return 1 ;;
      esac
      bash "$SCRIPTS_DIR/send" "$@"
      ;;

    paste)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane paste <text>"; return ;;
        "") echo "Error: text required" >&2; return 1 ;;
      esac
      local text="$*"
      _tmux load-buffer - <<< "$text"
      # -p: bracketed when the program in the pane asked for it (?2004h), so a
      # multi-line paste is inserted rather than run a line at a time.
      _run_safe "pasteb -p"
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

    --help|-h)
      usage_pane
      ;;

    "")
      usage_pane
      ;;

    *)
      echo "Unknown pane command: $sub" >&2
      usage_pane >&2
      return 1
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
      _run_shell "bash '$SCRIPTS_DIR/pane-group-add' #{pane_id} #{pane_width} #{pane_height}"
      ;;

    close)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group close [%id]"; return ;;
      esac
      local pane_id="${1:-"#{pane_id}"}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group-close' '$pane_id'"
      ;;

    switch)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group switch <%id>"; return ;;
      esac
      local pane_id="${1:?Usage: tmuxy pane group switch <pane_id>}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group-switch' '$pane_id'"
      ;;

    move)
      case "${1:-}" in
        --help|-h|"") echo "Usage: tmuxy pane group move <%id> <index>   (0 is first)"; [ -n "${1:-}" ] && return; return 1 ;;
      esac
      local pane_id="$1" index="${2:?Usage: tmuxy pane group move <%id> <index>}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group-move' $(shquote "$pane_id") $(shquote "$index")"
      ;;

    join)
      case "${1:-}" in
        --help|-h|"") echo "Usage: tmuxy pane group join <%id> <%member-or-pane> [index]"; [ -n "${1:-}" ] && return; return 1 ;;
      esac
      local pane_id="$1" anchor="${2:?Usage: tmuxy pane group join <%id> <%member-or-pane> [index]}" index="${3:-}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group-join' $(shquote "$pane_id") $(shquote "$anchor") $(shquote "$index")"
      ;;

    leave)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group leave [%id] [--tab | --beside <%id> <left|right|up|down>]"; return ;;
      esac
      local pane_id="${TMUX_PANE:-}"
      case "${1:-}" in %*) pane_id="$1"; shift ;; esac
      if [ -z "$pane_id" ]; then
        echo "Error: no pane to take out of its group (pass %id or run inside a pane)" >&2
        return 1
      fi
      local mode="${1:---tab}" beside="${2:-}" dir="${3:-right}"
      _run_shell "bash '$SCRIPTS_DIR/pane-group-leave' $(shquote "$pane_id") $(shquote "$mode") $(shquote "$beside") $(shquote "$dir")"
      ;;

    next)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group next"; return ;;
      esac
      _run_shell "bash '$SCRIPTS_DIR/pane-group-next' #{pane_id}"
      ;;

    prev)
      case "${1:-}" in
        --help|-h) echo "Usage: tmuxy pane group prev"; return ;;
      esac
      _run_shell "bash '$SCRIPTS_DIR/pane-group-prev' #{pane_id}"
      ;;

    --help|-h)
      usage_pane_group
      ;;

    "")
      usage_pane_group
      ;;

    *)
      echo "Unknown group command: $sub" >&2
      usage_pane_group >&2
      return 1
      ;;
  esac
}
