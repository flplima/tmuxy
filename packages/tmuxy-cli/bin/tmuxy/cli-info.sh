#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — info, agent and skill commands.

# --- Info & Skill ---

cmd_info() {
  local json="$JSON_OUT"
  for arg in "$@"; do
    case "$arg" in
      --help|-h) echo "Usage: tmuxy info [--json]"; return ;;
      *) _die_usage "invalid argument '$arg'" ;;
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
      printf '{"inside":false,"socket":%s,"serverRunning":%s,"version":%s,"agentSkillHint":"Run '\''%s skill'\'' to view the agent instruction guide"}\n' \
        "$(json_string "$TMUX_SOCKET")" "$server_running" "$(json_string "$TMUXY_VERSION")" "tmuxy"
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
    local pw="${pane_width:-0}" ph="${pane_height:-0}" wi="${window_index:-0}" wp="${window_panes:-0}"
    [[ "$pw" =~ ^[0-9]+$ ]] || pw=0
    [[ "$ph" =~ ^[0-9]+$ ]] || ph=0
    [[ "$wi" =~ ^-?[0-9]+$ ]] || wi=0
    [[ "$wp" =~ ^[0-9]+$ ]] || wp=0
    printf '{"inside":true,"socket":%s,"session":%s,"activePane":{"id":%s,"width":%s,"height":%s,"command":%s},"activeTab":{"id":%s,"index":%s,"name":%s,"panesCount":%s},"version":%s,"agentSkillHint":"Run '\''%s skill'\'' to view the full agent instruction guide and safety rules"}\n' \
      "$(json_string "$TMUX_SOCKET")" "$(json_string "${session_name:-}")" "$(json_string "${pane_id:-}")" "$pw" "$ph" "$(json_string "${pane_cmd:-}")" \
      "$(json_string "${window_id:-}")" "$wi" "$(json_string "${window_name:-}")" "$wp" "$(json_string "$TMUXY_VERSION")" "tmuxy"
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
      [ "$JSON_OUT" = true ] || exec "${SERVER_CMD[@]}" agent "$verb" "$@"
      local out status=0
      out=$("${SERVER_CMD[@]}" agent "$verb" "$@") || status=$?
      [ "$status" -eq 0 ] || _fail "$status" "$out"
      json_ok "output=$(json_string "$out")"
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
      _die_usage "Unknown agent command: $verb (try 'tmuxy agent --help')"
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
   which wraps mutations in `tmux run-shell`. Escape hatch: `tmuxy run <tmux cmd>`
   for commands that read, arrange or close panes and windows (`tmuxy run --help` lists
   them); it refuses keys, options, key bindings and anything that runs a shell — keys
   go through `pane send`.
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
tmuxy pane list --json          # id, tab, width, height, command, active, label (--all = every tab)
tmuxy pane split [-h|-v] [--json] # split pane (returns %id or JSON)
tmuxy pane run --wait -- npm test # run a command in a new pane and exit with ITS status
tmuxy pane run --label logs -- tail -f x.log  # keep it running; `-t logs` names it from now on
tmuxy pane wait <target> [--for 10m] # wait for the program in a pane; exit with its status
tmuxy pane float [opts] [cmd]   # open a float
tmuxy open <file.md|file.html>  # preview a markdown doc (mermaid too) or a page in this pane; follows the file, ctrl+c closes it
tmuxy pane capture [target] [--trim] [--unwrap] [--format text|vt|html] [--json] # a pane's screen
tmuxy pane send ls Enter        # type into a pane
tmuxy pane select -U|-D|-L|-R|target # select pane
tmuxy pane kill [target]        # close pane
tmuxy tab list --json           # tabs; also kill/select/next/prev/rename/layout
tmuxy tab create [name] [--json]# create tab (returns @id or JSON)
tmuxy pane group add            # group the current pane (members become header tabs)
tmuxy pane group join %id %m    # put %id in %m's group; also move, leave, switch, next, prev, close
tmuxy pane send -t <target> <keys...> # type into another pane; the user allows it there first (blocks until answered)
tmuxy session save [name]       # snapshot a session; also restore <name>, snapshots, forget <name>
tmuxy run <tmux cmd>            # a read/arrange/close tmux command, through run-shell
tmuxy config reload             # re-apply tmuxy.conf (and the whole config chain) to the running app
tmuxy config paths --json       # every file tmuxy reads or writes: owner, location, safe to edit/symlink
```

## The contract for scripts

- **Wait, don't poll.** `tmuxy pane run --wait -- <cmd>` returns when the
  command exits, with its exit status, so a script can branch on it:
  `if tmuxy pane run --wait -- npm test; then ok; else failed; fi`.
  `tmuxy pane wait <target>` does the same for a pane that already runs
  something. Capture the screen afterwards, not in a loop.
- **Targets:** a pane id (`%3`) or a label — the `@tmuxy-label` set by
  `pane run --label`, else the pane's title. A label naming no pane or more
  than one changes nothing and exits 3. A tab is its `@id`, index or name.
- **`--json` on every command:** queries keep their shape; a mutation answers
  `{"ok":true,...}` with the ids it made; a failure is
  `{"ok":false,"error":"…","code":N}` on stdout, N being the exit code.
- **Exit codes:** 0 ok · 1 failed (tmux refused, user declined, a wait timed
  out) · 2 bad command line · 3 target not found or ambiguous · 4 no tmux
  server on the socket · 130 interrupted. A wait passes the program's status
  through.

## Personalizing tmuxy

Everything the user can change lives in `~/.config/tmuxy/`. `tmuxy config paths`
lists every file with its owner and location; the guide is `README.md` in tmuxy's
data dir (`~/.local/share/tmuxy/`) — read it before changing a theme, a colour or
the tmux config. In short:

- Never edit an app-owned file (anything in the data dir: the built-in `themes/*.css`,
  `tmuxy.defaults.conf`): it is read-only and rewritten on every launch. Copy a theme
  into `~/.config/tmuxy/themes/` instead.
- Small tweaks: `custom.css` (any CSS), or `set -g @tmuxy-css-<variable> <value>` in
  `tmuxy.conf`. Options are `@tmuxy-*` in `tmuxy.conf`; `tmuxy config reload` applies it.
- An option set in `tmuxy.conf` is pinned: the menus cannot change it.
- A saved theme or `custom.css` repaints every open window by itself.
EOF
}
