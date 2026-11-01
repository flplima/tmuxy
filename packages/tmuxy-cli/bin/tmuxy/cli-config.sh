#!/usr/bin/env bash
# Sourced by packages/tmuxy-cli/bin/tmuxy-cli — the `tmuxy config` commands.

# --- Config ---
#
# The directories come from _lib (tmuxy_config_dir, tmuxy_data_dir,
# tmuxy_state_dir), resolved as tmuxy-core resolves them.

# Read one boolean out of tmuxy.state.json without a JSON parser: the file is
# written by serde_json's pretty printer, so a key sits on its own line.
state_bool() {
  local key="$1" file
  file="$(tmuxy_state_dir)/tmuxy.state.json"
  [ -f "$file" ] || return 1
  grep -Eq "\"$key\"[[:space:]]*:[[:space:]]*true" "$file"
}

# Set one boolean in tmuxy.state.json, keeping every other key: replaced where
# the key is, else added as the object's first member (with no comma when the
# object is empty), else the file becomes that one key. node and jq are not
# dependencies of the CLI, and a `\n` in a sed replacement is GNU-only (BSD
# sed writes a literal `n`), so this is POSIX awk over the whole file, written
# beside it and renamed over it.
set_state_bool() {
  local key="$1" value="$2" file src tmp
  file="$(tmuxy_state_dir)/tmuxy.state.json"
  tmp="$file.tmp.$$"
  src="$file"
  [ -f "$src" ] || src=/dev/null
  (umask 077 && awk -v key="$key" -v val="$value" '
    { text = text (NR > 1 ? "\n" : "") $0 }
    END {
      pair = "\"" key "\": " val
      if (match(text, "\"" key "\"[[:space:]]*:[[:space:]]*(true|false|null)")) {
        text = substr(text, 1, RSTART - 1) pair substr(text, RSTART + RLENGTH)
      } else if (match(text, /^[[:space:]]*\{[[:space:]]*\}/)) {
        text = "{\n  " pair "\n}" substr(text, RLENGTH + 1)
      } else if (match(text, /^[[:space:]]*\{/)) {
        text = substr(text, 1, RLENGTH) "\n  " pair "," substr(text, RLENGTH + 1)
      } else {
        text = "{\n  " pair "\n}"
      }
      print text
    }' "$src" > "$tmp") || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$file"
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
    init)
      shift
      cmd_config_init "$@"
      ;;
    paths)
      shift
      cmd_config_paths "$@"
      ;;
    ""|--help|-h)
      cat <<'EOF'
Usage: tmuxy config <setting> [value]

Settings:
  reload                   Re-apply the config to the running app: the whole
                           chain (defaults, your tmuxy.conf, essentials) is
                           re-sourced and every @tmuxy-* option re-read.
  use-tmux-conf [on|off]   Source your own ~/.tmux.conf on tmuxy's socket.
                           With no value, prints the current setting.
  init                     Write the starter tmuxy.conf into the config dir.
                           Refuses to overwrite one that exists.
  paths [--json]           Every file tmuxy reads or writes: its owner, where
                           it is, and whether it is safe to edit and to symlink.

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

# The app watches tmuxy.conf, and a marker in the state dir beside it, and
# sources the config chain on its own control-mode connection when either
# changes, then pushes the bindings and settings to every client. Touching the
# marker is the whole request: a raw `source-file` from here would apply the
# config to tmux but tell no client about it, and touching tmuxy.conf itself
# would write into the config dir, which may be a dotfiles checkout.
cmd_config_reload() {
  local marker
  marker="$(tmuxy_state_dir)/config-reload"
  mkdir -m 700 -p "${marker%/*}" || _fail "$EXIT_FAILED" "cannot create ${marker%/*}"
  (umask 077 && touch "$marker") || _fail "$EXIT_FAILED" "cannot touch $marker"
  if [ "$JSON_OUT" = true ]; then
    json_ok "file=$(json_string "$(tmuxy_config_dir)/tmuxy.conf")"
    return 0
  fi
  echo "Reloading $(tmuxy_config_dir)/tmuxy.conf — the app re-applies it within a second."
}

cmd_config_use_tmux_conf() {
  local dir state_file value="${1:-}"
  dir="$(tmuxy_state_dir)"
  state_file="$dir/tmuxy.state.json"

  if [ -z "$value" ]; then
    local on=false
    state_bool use_tmux_conf && on=true
    if [ "$JSON_OUT" = true ]; then
      json_ok "useTmuxConf=$on"
    elif $on; then
      echo "use-tmux-conf: on  (~/.tmux.conf is sourced, then tmuxy.essentials.conf on top)"
    else
      echo "use-tmux-conf: off (tmuxy uses its own config only)"
    fi
    return 0
  fi

  case "$value" in
    on|true|1) value=true ;;
    off|false|0) value=false ;;
    *) _die_usage "Usage: tmuxy config use-tmux-conf [on|off]" ;;
  esac

  mkdir -m 700 -p "$dir" || _fail "$EXIT_FAILED" "cannot create $dir"
  set_state_bool use_tmux_conf "$value" || _fail "$EXIT_FAILED" "cannot write $state_file"

  if [ "$JSON_OUT" = true ]; then
    json_ok "useTmuxConf=$value"
    return 0
  elif [ "$value" = true ]; then
    echo "use-tmux-conf: on — tmuxy will source ~/.tmux.conf, then re-apply its essentials."
  else
    echo "use-tmux-conf: off — tmuxy will use its own config only."
  fi
  echo "Restart tmuxy for this to take effect (the config chain is read when it connects)."
}

# The starter tmuxy.conf: the copy the app mirrors into its data dir, less the
# generated header above its first blank line; in a checkout that never ran
# the app, the asset itself.
starter_conf() {
  local example
  example="$(tmuxy_data_dir)/tmuxy.conf.example"
  if [ -f "$example" ]; then
    sed '1,/^$/d' "$example"
  elif [ -f "$SCRIPTS_DIR/../../../tmuxy-core/assets/tmuxy.conf" ]; then
    cat "$SCRIPTS_DIR/../../../tmuxy-core/assets/tmuxy.conf"
  else
    return 1
  fi
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
  local dir conf starter
  dir="$(tmuxy_config_dir)"
  conf="$dir/tmuxy.conf"
  # A dangling link counts: it is a dotfiles checkout not cloned yet.
  if [ -e "$conf" ] || [ -L "$conf" ]; then
    _fail "$EXIT_FAILED" "$conf already exists; not overwriting it"
  fi
  starter="$(starter_conf)" || _fail "$EXIT_FAILED" "no starter config found (start tmuxy once to install it)"
  mkdir -m 700 -p "$dir" || _fail "$EXIT_FAILED" "cannot create $dir"
  (umask 077 && printf '%s\n' "$starter" > "$conf") || _fail "$EXIT_FAILED" "cannot write $conf"
  if [ "$JSON_OUT" = true ]; then
    json_ok "file=$(json_string "$conf")"
    return 0
  fi
  echo "Wrote $conf"
}

# Every file tmuxy reads or writes, one per line:
#   dir|relative path|owner|safe to edit|safe to symlink|what it is
# The same table as the config README (packages/tmuxy-core/assets/config-README.md).
config_paths_table() {
  cat <<'EOF'
config|tmuxy.conf|user|yes|yes|Your overrides; tmuxy sources its defaults before it and its essentials after it.
config|custom.css|user|yes|yes|Your CSS, loaded last.
config|themes/|user|yes|yes|Your themes; a built-in's name replaces that built-in.
data|tmuxy.defaults.conf|tmuxy|no|no|tmuxy's taste: prefix, status line, bindings, the @tmuxy-* defaults.
data|tmuxy.essentials.conf|tmuxy|no|no|The settings tmuxy cannot work without, sourced first and last.
data|tmuxy.conf.example|tmuxy|no|no|The starter tmuxy.conf; `tmuxy config init` copies it.
data|themes/|tmuxy|no|no|The built-in themes, to read or copy.
data|bin/|tmuxy|no|no|The tmuxy CLI and its helper scripts.
data|README.md|tmuxy|no|no|The guide to these files.
state|tmuxy.entry.conf|tmuxy|no|no|The chain tmux starts with, built from your files and this machine's choices.
state|tmuxy.compat.conf|tmuxy|no|no|Only while your tmuxy.conf still sources the old defaults: a copy without that line.
state|tmuxy.state.json|tmuxy|no|no|Choices made in the app's menus.
state|servers.json|tmuxy|yes|no|The servers `tmuxy session connect` saved.
state|trace.json|tmuxy|yes|no|The Debug menu's trace switch.
state|launcher|tmuxy|no|no|The desktop app the ~/.local/bin/tmuxy shorthand runs.
state|tmuxy.pid|tmuxy|no|no|The running web server's pid (tmuxy-<port>.pid on another port).
state|config-reload|tmuxy|no|no|Touched by `tmuxy config reload`.
EOF
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
  local config data state
  config="$(tmuxy_config_dir)"
  data="$(tmuxy_data_dir)"
  state="$(tmuxy_state_dir)"

  local dir rel owner edit link about base path exists
  if [ "$JSON_OUT" = true ]; then
    local files="" sep=""
    while IFS='|' read -r dir rel owner edit link about; do
      case "$dir" in config) base="$config" ;; data) base="$data" ;; *) base="$state" ;; esac
      path="$base/$rel"
      path="${path%/}"
      exists=false
      { [ -e "$path" ] || [ -L "$path" ]; } && exists=true
      files="$files$sep{\"name\":$(json_string "$rel"),\"dir\":\"$dir\",\"path\":$(json_string "$path"),\"owner\":\"$owner\",\"safeToEdit\":$([ "$edit" = yes ] && echo true || echo false),\"safeToSymlink\":$([ "$link" = yes ] && echo true || echo false),\"exists\":$exists,\"about\":$(json_string "$about")}"
      sep=","
    done < <(config_paths_table)
    printf '{"dirs":{"config":%s,"data":%s,"state":%s},"files":[%s]}\n' \
      "$(json_string "$config")" "$(json_string "$data")" "$(json_string "$state")" "$files"
    return 0
  fi

  echo "config  $config"
  echo "        yours: safe to edit, safe to symlink; tmuxy writes it only on the first run"
  echo "data    $data"
  echo "        tmuxy's: mirrored on every launch, read-only; read or copy, never edit"
  echo "state   $state"
  echo "        this machine's: not config, never shared between machines"
  echo
  printf '%-6s  %-5s  %-4s  %-7s  %s\n' OWNER EDIT LINK EXISTS PATH
  while IFS='|' read -r dir rel owner edit link about; do
    case "$dir" in config) base="$config" ;; data) base="$data" ;; *) base="$state" ;; esac
    path="$base/$rel"
    exists=no
    { [ -e "${path%/}" ] || [ -L "${path%/}" ]; } && exists=yes
    printf '%-6s  %-5s  %-4s  %-7s  %s\n' "$owner" "$edit" "$link" "$exists" "$path"
  done < <(config_paths_table)
}
