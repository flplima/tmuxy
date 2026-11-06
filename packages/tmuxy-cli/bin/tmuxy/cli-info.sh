#!/usr/bin/env bash

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
      find_server_cmd || exit "$EXIT_FAILED"
      exec "${SERVER_CMD[@]}" agent "$verb" ${server_json[@]+"${server_json[@]}"} "$@"
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


# The agent guide is the server binary's: it embeds .agents/skills/tmuxy/SKILL.md,
# the same text `tmuxy agent install` installs.
cmd_skill() {
  case "${1:-}" in
    --help|-h) echo "Usage: tmuxy skill"; return ;;
  esac
  find_server_cmd || exit "$EXIT_FAILED"
  exec "${SERVER_CMD[@]}" skill ${server_json[@]+"${server_json[@]}"}
}
