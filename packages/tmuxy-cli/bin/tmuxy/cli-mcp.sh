#!/usr/bin/env bash

usage_mcp() {
  cat <<MEOF
Usage: tmuxy mcp [--port N] [--host H] [--session NAME] [--read-only] [--json]

Print the MCP endpoint of a running \`tmuxy server\`, and how to add it to an
MCP client. Any MCP client (Claude Code, Cursor, Zed, ...) can then see and
drive the tmux session tmuxy shows: list, read, split, float and close panes,
open tabs and previews, and type into a pane once you allow it there.

Options:
  --port N        The server's port (default $DEFAULT_PORT)
  --host H        The server's address (default 127.0.0.1)
  --session NAME  The session to drive (default: the one this pane is in)
  --read-only     Only the tools that change nothing: eyes, no hands

The endpoint is served by \`tmuxy server\`, behind its password when it has one.
MEOF
}

cmd_mcp() {
  local port=$DEFAULT_PORT host=127.0.0.1 session="" read_only=false
  while [ $# -gt 0 ]; do
    case "$1" in
      --help | -h) usage_mcp; return ;;
      --port) port="${2:-}"; shift 2 || _die_usage "--port needs a number" ;;
      --host) host="${2:-}"; shift 2 || _die_usage "--host needs an address" ;;
      --session) session="${2:-}"; shift 2 || _die_usage "--session needs a name" ;;
      --read-only) read_only=true; shift ;;
      *) _die_usage "invalid argument '$1'" usage_mcp ;;
    esac
  done
  case "$port" in '' | *[!0-9]*) _die_usage "--port takes a number (got '$port')" ;; esac
  [[ "$host" =~ ^[A-Za-z0-9.:_-]+$|^\[[0-9A-Fa-f:]+\]$ ]] || _die_usage "--host takes an address (got '$host')"
  if [ -z "$session" ] && [ -n "${TMUX:-}" ]; then
    session="$(_tmux display-message -p$CALLER_T '#{session_name}' 2>/dev/null || true)"
  fi
  [ -z "$session" ] || [[ "$session" =~ ^[A-Za-z0-9_@+][A-Za-z0-9_@+-]*$ ]] ||
    _die_usage "--session takes a session name (got '$session')"

  local query=""
  if [ -n "$session" ] && [ "$session" != "$DEFAULT_SESSION" ]; then query="session=$session"; fi
  if $read_only; then query="${query:+$query&}read-only"; fi
  local url="http://$host:$port/mcp${query:+?$query}"

  if [ "$JSON_OUT" = true ]; then
    json_ok "url=$(json_string "$url")" "session=$(json_string "${session:-$DEFAULT_SESSION}")" "readOnly=$read_only"
    return 0
  fi
  cat <<MEOF
tmuxy's MCP endpoint (served by \`tmuxy server\` on port $port):

  $url

Add it to Claude Code:

  claude mcp add --transport http tmuxy '$url'

If the server has a password (TMUXY_PASSWORD), the client sends it too:

  claude mcp add --transport http tmuxy '$url' \\
    --header "Authorization: Basic \$(printf 'tmuxy:%s' "\$TMUXY_PASSWORD" | base64)"
MEOF
}
