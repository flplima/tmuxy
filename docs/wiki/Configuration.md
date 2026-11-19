tmuxy is configured with plain tmux config in one file, `tmuxy.conf`. Saving it applies the change to the running app within a second. No restart, no page reload.

## Where the files are

tmuxy keeps its files in three directories, split by who owns them.

| Directory | Default                                                               | Owner                                                         |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| config    | `~/.config/tmuxy`                                                     | you. Safe to edit, safe to symlink from a dotfiles repo       |
| data      | `~/.local/share/tmuxy`                                                | tmuxy. Rewritten on every launch. Read and copy, never edit   |
| state     | `~/.local/state/tmuxy` (macOS: `~/Library/Application Support/tmuxy`) | tmuxy. This machine's state. Do not share it between machines |

tmuxy writes the config dir once, on the first run, and never again. Delete `tmuxy.conf` and tmuxy runs on its defaults.

```bash
# Every file tmuxy reads or writes, where it is, and whether it is safe to edit.
tmuxy config paths

# The same, for a script.
tmuxy config paths --json
```

The files in your config dir:

| File                                            | What it is                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `tmuxy.conf`                                    | Your overrides                                                                                                         |
| `custom.css`                                    | Your CSS, loaded last (see [[Themes and Appearance]])                                                                  |
| `themes/<name>.css`                             | Your themes                                                                                                            |
| `icons/<name>.svg`                              | SVG icons for `@tmuxy-icon-<process>`                                                                                  |
| `permissions.json`                              | Rules for what a caller may type into another pane (see [[Send Permissions]])                                          |
| `tmuxy-plugin.toml`, `plugins.json`, `plugins/` | Your own actions, and the plugins you installed (see [[Plugins]])                                                      |
| `server.env`                                    | Read by the web server that `tmuxy server install` keeps running. Holds `TMUXY_PASSWORD=...`. Create it with mode 0600 |
| `profiles/<name>.json`                          | Profiles (below)                                                                                                       |

## Write your `tmuxy.conf`

```bash
# Write the starter file. It refuses to overwrite one that exists.
tmuxy config init
```

It is a normal tmux config. These lines work as examples:

```bash
set -g @tmuxy-theme nord
set -g @tmuxy-opacity 0.85
set -g @tmuxy-inactive-pane-opacity 0.6
set -g @tmuxy-blur off
set -g @tmuxy-animations off
set -g @tmuxy-cursor-blink off
```

## The config commands

| Command                                | What it does                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tmuxy config reload`                  | Re-source the whole chain and re-read every `@tmuxy-*` option. Refused while tmux cannot parse your config, and the running one is kept                                                    |
| `tmuxy config check [file] [--json]`   | What is wrong, with file and line, without applying it: a line tmux cannot parse, an unknown option, a `source-file` with no file. Exit 1 if anything is. _On main, not in a release yet._ |
| `tmuxy config doctor [--fix] [--json]` | Lists `source-file` lines whose file is missing and exits 1. With `--fix`, comments each out and keeps a dated backup                                                                      |
| `tmuxy config use-tmux-conf [on\|off]` | Use your own `~/.tmux.conf` (below). With no value, prints the setting                                                                                                                     |
| `tmuxy config init`                    | Write the starter `tmuxy.conf`                                                                                                                                                             |
| `tmuxy config paths [--json]`          | Every file tmuxy touches                                                                                                                                                                   |
| `tmuxy config permissions`             | What `permissions.json` says (see [[Send Permissions]])                                                                                                                                    |

A `source-file` line whose file does not exist stops tmux reading the config at that line. Everything after it is lost. `tmuxy config doctor` finds those.

## The `@tmuxy-*` options

Set these in `tmuxy.conf` with `set -g`. Switches take `on` or `off`. Opacities run from 0.0 to 1.0.

| Option                          | Default    | What it does                                                                                                |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `@tmuxy-theme`                  | `default`  | The theme's file name, without `.css`                                                                       |
| `@tmuxy-theme-mode`             | `dark`     | `dark`, `light` or `auto` (follow the OS)                                                                   |
| `@tmuxy-opacity`                | `0.7`      | Window chrome: title bar, sidebar, the gaps between panes                                                   |
| `@tmuxy-active-pane-opacity`    | `1`        | The active pane's background                                                                                |
| `@tmuxy-inactive-pane-opacity`  | `0.7`      | Every other pane's background                                                                               |
| `@tmuxy-active-text-opacity`    | `1`        | The active pane's header and text                                                                           |
| `@tmuxy-inactive-text-opacity`  | `0.7`      | Every other pane's header and text. This is the focus cue                                                   |
| `@tmuxy-blur`                   | `on`       | Native blur behind the window (macOS only)                                                                  |
| `@tmuxy-transparency`           | `on`       | Off gives an opaque window and no blur                                                                      |
| `@tmuxy-animations`             | `on`       | Pane morphs, swaps, resizes and float animations                                                            |
| `@tmuxy-cursor-blink`           | `on`       | A blinking cursor. A program asking for a steady one still gets it                                          |
| `@tmuxy-send-ask`               | `on`       | `tmuxy pane send` into another pane asks first                                                              |
| `@tmuxy-send-allow`             | unset      | Callers (`claude,codex`) and panes (`%3,%5`) that never ask                                                 |
| `@tmuxy-send-allow-into`        | unset      | Programs (`claude,agy`) whose panes a send never asks about                                                 |
| `@tmuxy-confirm-close`          | `on`       | Closing a pane or tab asks first while a pane in it is working or waiting. _On main, not in a release yet._ |
| `@tmuxy-notify`                 | `on`       | Push a notification when a pane needs you or errors, to devices that turned it on                           |
| `@tmuxy-tab-overview-cols`      | `3`        | Cards per row in the tab overview, 1 to 12                                                                  |
| `@tmuxy-gesture-swipe-tabs`     | `on`       | Two-finger slide switches tabs                                                                              |
| `@tmuxy-gesture-pinch-zoom`     | `on`       | Pinch out zooms a pane, pinch in unzooms                                                                    |
| `@tmuxy-gesture-pinch-overview` | `on`       | Pinch in on an unzoomed tab opens the tab overview                                                          |
| `@tmuxy-native-menus`           | `on`       | Desktop app: native menu bar and popups. Off keeps the in-app menus                                         |
| `@tmuxy-size`                   | `smallest` | Grid size across clients: `smallest`, `largest`, `latest`, or a fixed `COLSxROWS` like `80x25`              |
| `@tmuxy-css-<variable>`         | unset      | One CSS variable (see [[Themes and Appearance]])                                                            |
| `@tmuxy-icon-<process>`         | unset      | The icon for panes running `<process>` (see [[Rich Rendering and Previews]])                                |

Turning a gesture off hands it back to the browser or webview. The three gestures are in the desktop app only.

## Menu choices and pinned options

The menus change five options: `@tmuxy-theme`, `@tmuxy-theme-mode`, `@tmuxy-transparency`, `@tmuxy-cursor-blink` and `@tmuxy-send-ask`. tmuxy remembers each choice and puts it back on every start.

An option your `tmuxy.conf` sets is **pinned**. The menu shows it greyed out and says "set in tmuxy.conf", and the remembered choice is not put back over it.

```bash
# Pin the theme on every machine that shares your dotfiles.
set -g @tmuxy-theme nord
```

To hand the choice back to the menu, delete the line.

## Use your own `~/.tmux.conf`

tmuxy starts tmux with its own config, so your prefix, status line and plugins are not loaded by default. To bring them in:

```bash
tmuxy config use-tmux-conf on
```

It takes effect the next time tmuxy connects to its tmux server. Your file loads after tmuxy's defaults and before `tmuxy.conf`. Then tmuxy re-applies the settings it cannot work without. Your prefix, status line and plugins win.

Two things to know:

- Plugin managers such as tpm load too. A plugin like `tmux-continuum` will save and restore sessions on tmuxy's socket.
- A status line that draws itself can fight tmuxy's own chrome. It is cosmetic but ugly.

The order tmuxy sources things in is:

1. `tmuxy.essentials.conf` (so the command aliases exist)
2. `tmuxy.defaults.conf` (tmuxy's taste: prefix, bindings, option defaults)
3. your `~/.tmux.conf`, only after `use-tmux-conf on`
4. your `tmuxy.conf`
5. `tmuxy.essentials.conf` again

The essentials fix settings that tmuxy needs, such as `destroy-unattached off`, `escape-time 0`, `history-limit` and `default-terminal`. Your config cannot change them. A bigger `history-limit` in your file is put back.

## Profiles

A profile is a named set of look-and-feel settings: the theme, its mode, the blinking cursor and transparency. Each session can use one. _On main, not in a release yet._

View ▸ Profiles lists them, with the session's checked. Pick one and the session switches at once. Other sessions keep their settings.

| Item               | What it does                                                |
| ------------------ | ----------------------------------------------------------- |
| New Profile…       | Make an empty profile and switch to it                      |
| Duplicate Profile… | Copy the session's profile under a new name                 |
| Rename Profile…    | Rename it. Sessions using it follow                         |
| Delete Profile…    | Delete it. Sessions using it go back to the Default Profile |

The **Default Profile** is not a file and changes nothing. A session on it gets the global settings. A profile lives in `profiles/<name>.json` in your config dir and holds only what it changes. Its keys are `theme`, `themeMode`, `cursorBlink` and `transparency`.

A change made from the menus in a profiled session is saved into that profile. Asking before a send is never part of a profile, so a profile cannot loosen it. Sessions are matched by name, so a renamed session loses its profile.

## Environment variables

| Variable                             | What it does                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`   | Move the config and data dirs                                                                                                                                             |
| `TMUXY_DATA_DIR`, `TMUXY_STATE_DIR`  | Move the data and state dirs                                                                                                                                              |
| `TMUX_SOCKET`                        | The tmux socket to use. A name for tmux's default socket directory, or a full path if it contains a slash. `TMUX_SOCKET=default tmuxy server` serves your own tmux server |
| `TMUXY_PASSWORD`                     | Password for the web server (see [[Remote Access]])                                                                                                                       |
| `TMUXY_NO_DESKTOP_ENTRY=1`           | Do not add tmuxy to the applications menu (Linux)                                                                                                                         |
| `TMUXY_NO_RESTORE=1`                 | Start a missing session empty even when a snapshot exists                                                                                                                 |
| `DO_NOT_TRACK=1`, `TMUXY_NO_TRACE=1` | Force the local action trace off everywhere                                                                                                                               |

## See also

- [[Keybindings]]
- [[Themes and Appearance]]
- [[Plugins]]
- [[Troubleshooting]]
