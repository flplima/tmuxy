#!/usr/bin/env bash

usage_plugin() {
  cat <<'EOF'
Usage: tmuxy plugin <command> [args...]

Commands:
  install       Install by name from the index, from GitHub
                <owner/repo[/subdir][@ref]>, or link a local directory
                (--path DIR); with no argument, install exactly what
                plugins.json lists [--yes --sha COMMIT...]
  search        Search the plugin index [query]
  list          The installed plugins [--json]
  update        Move plugins to the latest commit of their ref [name]
  remove        Uninstall a plugin <name> [--purge] [--force: and its dependents]
  config        A plugin's settings <name> [key [value]] [--unset]
  path          Where a plugin is installed <name>
  action        Run an action on a pane <plugin>:<id> [--pane %id] [--wait]
                [-- args...]
  log           What a plugin ran, and how it exited <name> [-f]
  check         Validate a plugin directory [dir]
  new           Write a plugin to start from, tmuxy-<name>/ <name>
  <verb>        An installed plugin's own command [args...] (see 'list')

Plugin commands run unsandboxed as your user and can control every pane.
Install shows what a plugin can do and asks first; without a terminal it
needs --yes and a --sha <commit> for each commit it showed you (the plugin's
and each dependency's). docs/PLUGINS.md describes the
manifest (tmuxy-plugin.toml).
EOF
}

# `tmuxy plugin`: everything is the server binary's (`tmuxy_core::plugins`),
# a plugin's own verbs (`tmuxy plugin <verb>`) included. `--json` goes before
# the command, where it is the binary's switch rather than a verb's argument.
# `action` acts on the caller's pane unless one is named; it runs here, and
# puts the one command list that opens the pane through run-shell itself.
cmd_plugin() {
  case "${1:-}" in
    "" | --help | -h | help)
      usage_plugin
      return 0
      ;;
  esac
  find_server_cmd || exit "$EXIT_FAILED"
  if [ "$1" != action ]; then
    # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
    exec "${SERVER_CMD[@]}" plugin ${server_json[@]+"${server_json[@]}"} "$@"
  fi
  shift
  local arg named=false pane=()
  for arg in "$@"; do
    case "$arg" in
      --) break ;;
      --pane | --pane=*) named=true ;;
    esac
  done
  if [ "$named" = false ] && [ -n "${TMUX_PANE:-}" ]; then
    pane=(--pane "$TMUX_PANE")
  fi
  # shellcheck disable=SC2154 # server_json is set by tmuxy-cli, which sources this file
  exec "${SERVER_CMD[@]}" plugin ${server_json[@]+"${server_json[@]}"} action ${pane[@]+"${pane[@]}"} "$@"
}
