#!/usr/bin/env bash

# Every setting is the server binary's `config`: the files it reads and
# writes are tmuxy-core's, which also says what they mean.
# `reload` touches a marker the app watches; the app re-sources the config on
# its own control-mode connection and pushes it to every client, where a raw
# `source-file` from here would apply it to tmux but tell no client.
config_verb() {
  find_server_cmd || exit "$EXIT_FAILED"
  if [ "$JSON_OUT" = true ]; then
    exec "${SERVER_CMD[@]}" config "$@" --json
  fi
  exec "${SERVER_CMD[@]}" config "$@"
}

cmd_config() {
  local setting="${1:-}"
  case "$setting" in
    reload)
      config_verb reload
      ;;
    check)
      shift
      cmd_config_check "$@"
      ;;
    use-tmux-conf)
      shift
      cmd_config_use_tmux_conf "$@"
      ;;
    init)
      shift
      cmd_config_init "$@"
      ;;
    paths)
      shift
      cmd_config_paths "$@"
      ;;
    doctor)
      shift
      cmd_config_doctor "$@"
      ;;
    ""|--help|-h)
      cat <<'EOF'
Usage: tmuxy config <setting> [value]

Settings:
  reload                   Re-apply the config to the running app: the whole
                           chain (defaults, your tmuxy.conf, essentials) is
                           re-sourced and every @tmuxy-* option re-read.
                           Refused while tmux cannot parse your config: the
                           running one is kept.
  check [file] [--json]    What is wrong with your config, with file and line,
                           found without applying it: a line tmux cannot
                           parse, an option it does not have, a source-file
                           whose file is not there. Reads your tmuxy.conf
                           (and ~/.tmux.conf when it is sourced) and what they
                           source, or the file you name. Exit 1 when there is
                           anything.
  use-tmux-conf [on|off]   Source your own ~/.tmux.conf on tmuxy's socket.
                           With no value, prints the current setting.
  init                     Write the starter tmuxy.conf into the config dir.
                           Refuses to overwrite one that exists.
  paths [--json]           Every file tmuxy reads or writes: its owner, where
                           it is, and whether it is safe to edit and to symlink.
  doctor [--fix] [--json]  The source-file lines of your tmuxy.conf whose file
                           is not there (tmux stops reading the config at the
                           first one): list them and exit 1, or with --fix
                           comment each out in place, keeping a timestamped
                           backup beside the file.

Your files live in the config dir (~/.config/tmuxy), which tmuxy never writes
after the first run, so it is safe to symlink from a dotfiles repo. tmuxy's own
files are in its data dir, this machine's state in its state dir.

With `use-tmux-conf on`, tmuxy sources ~/.tmux.conf after its defaults and
before your tmuxy.conf, then re-applies tmuxy.essentials.conf on top: your
prefix, status line and plugins win over tmuxy's defaults, and the settings
tmuxy needs to function are restored afterwards whatever your config did to
them. It takes effect the next time tmuxy connects to its tmux server.
EOF
      ;;
    *)
      [ "$JSON_OUT" = true ] || echo "Hint: tmuxy config --help" >&2
      _die_usage "Unknown config setting: $setting"
      ;;
  esac
}

cmd_config_use_tmux_conf() {
  case "${1:-}" in
    "") config_verb use-tmux-conf ;;
    on|true|1) config_verb use-tmux-conf on ;;
    off|false|0) config_verb use-tmux-conf off ;;
    *) _die_usage "Usage: tmuxy config use-tmux-conf [on|off]" ;;
  esac
}

cmd_config_init() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        echo "Usage: tmuxy config init [--json]"
        echo "Write the starter tmuxy.conf into the config dir; refuses to overwrite one."
        return 0
        ;;
      *) _die_usage "invalid argument '$arg'" ;;
    esac
  done
  config_verb init
}

cmd_config_paths() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        echo "Usage: tmuxy config paths [--json]"
        echo "Every file tmuxy reads or writes: owner, location, safe to edit, safe to symlink."
        return 0
        ;;
      *) _die_usage "invalid argument '$arg'" ;;
    esac
  done
  config_verb paths
}

cmd_config_doctor() {
  local fix=()
  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        echo "Usage: tmuxy config doctor [--fix] [--json]"
        echo "List the source-file lines of tmuxy.conf whose file is not there (exit 1 if any);"
        echo "--fix comments each out in place, with a tmuxy.conf.bak-<date> backup beside it."
        return 0
        ;;
      --fix) fix=(--fix) ;;
      *) _die_usage "invalid argument '$arg'" ;;
    esac
  done
  config_verb doctor ${fix[@]+"${fix[@]}"}
}

cmd_config_check() {
  local file=()
  for arg in "$@"; do
    case "$arg" in
      --help|-h)
        echo "Usage: tmuxy config check [file] [--json]"
        echo "What is wrong with your config, with file and line, found without applying it"
        echo "(exit 1 if anything): a line tmux cannot parse, an option it does not have, a"
        echo "source-file whose file is not there. Reads your tmuxy.conf (and ~/.tmux.conf"
        echo "when it is sourced) and what they source, or the file you name."
        return 0
        ;;
      -*) _die_usage "invalid argument '$arg'" ;;
      *)
        [ ${#file[@]} -eq 0 ] || _die_usage "Usage: tmuxy config check [file] [--json]"
        file=("$arg")
        ;;
    esac
  done
  config_verb check ${file[@]+"${file[@]}"}
}
