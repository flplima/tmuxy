#!/usr/bin/env bash
# Sourced by bin/tmuxy-cli — config, info, agent and skill commands.

# --- Config ---

# Where tmuxy keeps its config and state. Mirrors tmuxy-core's config_dir().
tmuxy_config_dir() {
  echo "${XDG_CONFIG_HOME:-$HOME/.config}/tmuxy"
}

# Read one boolean out of tmuxy.state.json without a JSON parser: the file is
# written by serde_json's pretty printer, so a key sits on its own line.
state_bool() {
  local key="$1" file
  file="$(tmuxy_config_dir)/tmuxy.state.json"
  [ -f "$file" ] || return 1
  grep -q "\"$key\": true" "$file"
}

cmd_config() {
  local setting="${1:-}"
  case "$setting" in
    reload)
      cmd_config_reload
      ;;
    use-tmux-conf)
      shift
      cmd_config_use_tmux_conf "$@"
      ;;
    ""|--help|-h)
      cat <<'EOF'
Usage: tmuxy config <setting> [value]

Settings:
  reload                   Re-apply ~/.config/tmuxy/tmuxy.conf to the running app:
                           the bindings and every @tmuxy-* option are re-read.
  use-tmux-conf [on|off]   Source your own ~/.tmux.conf on tmuxy's socket.
                           With no value, prints the current setting.

With `use-tmux-conf on`, tmuxy sources ~/.tmux.conf and then re-applies
tmuxy.essentials.conf on top: your prefix, status line and plugins win over
tmuxy's defaults, and the settings tmuxy needs to function are restored
afterwards whatever your config did to them.

Takes effect on the next tmux server start for that socket — the config chain
is read when the server starts, so restart tmuxy (or `tmuxy server stop`) after
changing it.
EOF
      ;;
    *)
      echo "Unknown config setting: $setting" >&2
      echo "Hint: tmuxy config --help" >&2
      return 1
      ;;
  esac
}

# The app watches tmuxy.conf and sources it on its own control-mode connection
# when the file changes, then pushes the bindings and settings to every client.
# Marking the file modified is the whole request: a raw `source-file` from
# here would apply the config to tmux but tell no client about it.
cmd_config_reload() {
  local conf
  conf="$(tmuxy_config_dir)/tmuxy.conf"
  if [ ! -f "$conf" ]; then
    echo "Error: $conf does not exist (start tmuxy once to create it)" >&2
    return 1
  fi
  touch "$conf"
  echo "Reloading $conf — the app re-applies it within a second."
}

cmd_config_use_tmux_conf() {
  local dir state_file value="${1:-}"
  dir="$(tmuxy_config_dir)"
  state_file="$dir/tmuxy.state.json"

  if [ -z "$value" ]; then
    if state_bool use_tmux_conf; then
      echo "use-tmux-conf: on  (~/.tmux.conf is sourced, then tmuxy.essentials.conf on top)"
    else
      echo "use-tmux-conf: off (tmuxy uses its own config only)"
    fi
    return 0
  fi

  case "$value" in
    on|true|1) value=true ;;
    off|false|0) value=false ;;
    *)
      echo "Usage: tmuxy config use-tmux-conf [on|off]" >&2
      return 1
      ;;
  esac

  mkdir -p "$dir"
  # Rewrite the one key, preserving everything else in the file. node is not a
  # dependency of the CLI, so this is done with the tools a shell always has.
  if [ -f "$state_file" ]; then
    if grep -q '"use_tmux_conf"' "$state_file"; then
      # -E: BSD sed has no \| alternation in a basic regex, and silently
      # matches nothing rather than erroring — which read as "off does not work".
      sed -i.bak -E "s/(\"use_tmux_conf\": )(true|false)/\1$value/" "$state_file"
      rm -f "$state_file.bak"
    else
      # Insert after the opening brace so the file stays valid JSON.
      sed -i.bak "1s/^{/{\n  \"use_tmux_conf\": $value,/" "$state_file"
      rm -f "$state_file.bak"
    fi
  else
    printf '{\n  "use_tmux_conf": %s\n}\n' "$value" > "$state_file"
  fi

  if [ "$value" = true ]; then
    echo "use-tmux-conf: on — tmuxy will source ~/.tmux.conf, then re-apply its essentials."
  else
    echo "use-tmux-conf: off — tmuxy will use its own config only."
  fi
  echo "Restart tmuxy for this to take effect (the config chain is read at tmux server start)."
}

# --- Info & Skill ---

cmd_info() {
  local json=false
  for arg in "$@"; do
    case "$arg" in
      --help|-h) echo "Usage: tmuxy info [--json]"; return ;;
      --json) json=true ;;
    esac
  done

  local inside=false
  if [ -n "${TMUX:-}" ]; then
    inside=true
  fi

  if ! $inside; then
    local server_running=false
    if _tmux has-session 2>/dev/null; then
      server_running=true
    fi
    if $json; then
      printf '{"inside":false,"socket":"%s","serverRunning":%s,"version":"%s","agentSkillHint":"Run '\''%s skill'\'' to view the agent instruction guide"}\n' \
        "$TMUX_SOCKET" "$server_running" "$TMUXY_VERSION" "tmuxy"
    else
      echo "tmuxy $TMUXY_VERSION"
      if $server_running; then
        echo "  Status: not inside a tmuxy session (server is running on socket '$TMUX_SOCKET')"
      else
        echo "  Status: not inside a tmuxy session (no server on socket '$TMUX_SOCKET')"
      fi
      echo "  Tip:    Run 'tmuxy gui' to open the desktop app, or 'tmuxy connect' to attach."
      echo ""
      echo "Agent Guide:"
      echo "  • Run 'tmuxy skill' to print the full agent instructions & safety rules."
      echo "  • Run 'tmuxy --json' for machine-readable state."
    fi
    return
  fi

  # Inside session — read session, active pane, and active window in one display-message call
  local fmt=$'#{session_name}\t#{pane_id}\t#{window_id}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{window_index}\t#{window_name}\t#{window_panes}'
  local info_line
  info_line=$(_tmux display-message -p "$fmt" 2>/dev/null || true)

  local session_name pane_id window_id pane_width pane_height pane_cmd window_index window_name window_panes
  IFS=$'\t' read -r session_name pane_id window_id pane_width pane_height pane_cmd window_index window_name window_panes <<< "$info_line"

  if $json; then
    printf '{"inside":true,"socket":"%s","session":"%s","activePane":{"id":"%s","width":%s,"height":%s,"command":"%s"},"activeTab":{"id":"%s","index":%s,"name":"%s","panesCount":%s},"version":"%s","agentSkillHint":"Run '\''%s skill'\'' to view the full agent instruction guide and safety rules"}\n' \
      "$TMUX_SOCKET" "${session_name:-}" "${pane_id:-}" "${pane_width:-0}" "${pane_height:-0}" "${pane_cmd:-}" \
      "${window_id:-}" "${window_index:-0}" "${window_name:-}" "${window_panes:-0}" "$TMUXY_VERSION" "tmuxy"
  else
    echo "tmuxy $TMUXY_VERSION (socket: $TMUX_SOCKET, session: ${session_name:-$TMUX_SOCKET})"
    echo "  Status:  attached (control mode active)"
    echo "  Pane:    ${pane_id:-%0} (${pane_width:-0}x${pane_height:-0}, ${pane_cmd:-shell})"
    echo "  Tab:     ${window_id:-@0} (name: \"${window_name:-tmuxy}\", ${window_panes:-1} pane)"
    echo ""
    echo "Agent Guide:"
    echo "  • Run 'tmuxy skill' to print the full agent instructions & safety rules."
    echo "  • Run 'tmuxy --json' for machine-readable state."
    echo "  • Warning: Do NOT run raw mutating tmux commands (use 'tmuxy pane/tab/run')."
  fi
}

# The one copy of the agent guide. .agents/skills/tmuxy/SKILL.md is this text
# verbatim (a CLI test fails when they differ): an installed CLI has no repo to
# read the skill file from, so the heredoc is the source.
# Coding agents in tmuxy panes: `install` wires an agent's lifecycle hooks to
# `tmuxy agent hook`, which turns each event into the pane's
# `@tmuxy-pane-state`, and installs the skill. The editing of each agent's
# own config lives in the server binary (`agents.rs`); what an event means
# too, so the hooks stay a bare command that an upgrade never has to rewrite.
cmd_agent() {
  local verb="${1:-}"
  [ $# -gt 0 ] && shift
  case "$verb" in
    install|uninstall|status)
      find_server_cmd
      exec "${SERVER_CMD[@]}" agent "$verb" "$@"
      ;;
    ""|--help|-h)
      cat <<EOF
Usage: tmuxy agent <install|uninstall|status> [claude|codex|agy]...

Show what a coding agent is doing on its tree row: working, waiting for you,
done, failed. Its lifecycle hooks report to tmuxy; the tmuxy skill is
installed alongside, so the agent knows the CLI.

  install     Add the hooks and the skill (default: every agent found)
  uninstall   Remove them, leaving everything else as it was
  status      What is installed, per agent

Options:
  --hooks-only | --skill-only
  --project   This project's config (./.claude, ./.codex, ./.agents)
              instead of the home directory's
  --dry-run   Say what would change; write nothing
  --force     (install) Replace a tmuxy skill tmuxy did not write
EOF
      ;;
    *)
      echo "Unknown agent command: $verb (try 'tmuxy agent --help')" >&2
      return 1
      ;;
  esac
}


cmd_skill() {
  case "${1:-}" in
    --help|-h) echo "Usage: tmuxy skill"; return ;;
  esac
  cat <<'EOF'
---
name: tmuxy
description: Working inside tmuxy (web/desktop tmux interface). Covers tmuxy CLI, control-mode safety rules (never run mutating raw tmux commands), and pane/tab/widget operations.
---

# tmuxy

tmuxy is a web/desktop UI over a real tmux server. When running inside tmuxy, panes, tabs and floats are real UI surfaces you can drive from the shell, not just tmux abstractions.

## Am I inside tmuxy?

```sh
[ -n "$TMUX" ] && [ "$(basename "${TMUX%%,*}")" = "tmuxy" ]
```

`$TMUX` is `<socket-path>,<server-pid>,<session-id>`; the socket basename is `tmuxy` (or `tmuxy-dev`).

## Hard rules

1. **Never run a mutating raw `tmux` command.** External `tmux` mutations crash tmux
   3.3a–3.5a while control mode is attached. Route everything through the `tmuxy` CLI,
   which wraps mutations in `tmux run-shell`. Escape hatch: `tmuxy run <any tmux cmd>`.
2. **Read-only `tmux` is fine** as a direct subprocess (`display-message -p`,
   `list-panes`, `show-options -qv`).
3. **Never use `new-window`/`neww`** — it crashes tmux 3.5a. `tmuxy tab create` does
   `splitw ; breakp` instead.
4. Kill a stray float with `tmuxy pane kill %id`, never `tmux kill-window`.

## CLI cheat sheet

```sh
tmuxy                           # status and multiplexer info
tmuxy --json                    # machine-readable status
tmuxy skill                     # print this guide
tmuxy pane list --json          # id, tab, width, height, command, active (--all = every tab)
tmuxy pane split [-h|-v] [--json] # split pane (returns %id or JSON)
tmuxy pane float [opts] [cmd]   # open a float
tmuxy pane capture [%id] --json # read what's on a pane's screen
tmuxy pane send ls Enter        # type into a pane
tmuxy pane select -U|-D|-L|-R|%id # select pane
tmuxy pane kill [%id]           # close pane
tmuxy tab list --json           # tabs; also kill/select/next/prev/rename/layout
tmuxy tab create [name] [--json]# create tab (returns @id or JSON)
tmuxy pane group add            # group the current pane (members become header tabs)
tmuxy pane group join %id %m    # put %id in %m's group; also move, leave, switch, next, prev, close
tmuxy pane send -t %id <keys...># type into another pane; the user allows it there first (blocks until answered)
tmuxy session save [name]       # snapshot a session; also restore <name>, snapshots, forget <name>
tmuxy run <tmux cmd>            # any tmux command, routed safely through run-shell
tmuxy config reload             # re-apply ~/.config/tmuxy/tmuxy.conf to the running app
```

## Personalizing tmuxy

Everything the user can change lives in `~/.config/tmuxy/`; its `README.md` is the
guide — read it before changing a theme, a colour or the tmux config. In short:

- Never edit an app-owned file (the built-in `themes/*.css`, `tmuxy.defaults.conf`):
  it is rewritten on every launch. Copy a theme to a new name instead.
- Small tweaks: `custom.css` (any CSS), or `set -g @tmuxy-css-<variable> <value>` in
  `tmuxy.conf`. Options are `@tmuxy-*` in `tmuxy.conf`; `tmuxy config reload` applies it.
- A saved theme or `custom.css` repaints every open window by itself.
EOF
}
