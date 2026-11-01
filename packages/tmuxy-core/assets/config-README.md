# Personalizing tmuxy

tmuxy keeps its files in three directories, split by who owns them. Only the
first is yours, and it is the only one you edit; it is safe to keep in a
dotfiles repo and symlink, because tmuxy never writes into it after the first
run. Edits there apply to the running app — a saved file is picked up within a
second, no restart and no page reload.

| Directory | Default                                                                                 | Owner | Rule                                                                      |
| --------- | --------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------- |
| config    | `~/.config/tmuxy` (`$XDG_CONFIG_HOME/tmuxy`)                                            | you   | Written once, on the very first run. Safe to edit, safe to symlink.       |
| data      | `~/.local/share/tmuxy` (`$XDG_DATA_HOME/tmuxy`, `TMUXY_DATA_DIR`)                       | tmuxy | Mirrored from the app on every launch, read-only. Read, copy, never edit. |
| state     | `~/.local/state/tmuxy`, macOS `~/Library/Application Support/tmuxy` (`TMUXY_STATE_DIR`) | tmuxy | This machine's state. Not config: do not share it between machines.       |

`tmuxy config paths` prints every file below with its real location on this
machine (`--json` for a script).

## The files, and who owns them

| File                    | Dir    | Owner | Safe to edit | Safe to symlink | What it is                                                                             |
| ----------------------- | ------ | ----- | ------------ | --------------- | -------------------------------------------------------------------------------------- |
| `tmuxy.conf`            | config | you   | yes          | yes             | Your overrides. tmuxy sources its defaults before it and its essentials after it.      |
| `custom.css`            | config | you   | yes          | yes             | Your CSS, loaded last. Create it to tweak anything the themes do not cover.            |
| `themes/<name>.css`     | config | you   | yes          | yes             | Your themes. A name of a built-in replaces that built-in; any other name adds a theme. |
| `tmuxy.defaults.conf`   | data   | tmuxy | no           | no              | tmuxy's taste: prefix, status line, bindings, the `@tmuxy-*` defaults.                 |
| `tmuxy.essentials.conf` | data   | tmuxy | no           | no              | The settings tmuxy cannot work without, sourced first and last.                        |
| `tmuxy.entry.conf`      | data   | tmuxy | no           | no              | The chain tmux starts with, built from the files around it.                            |
| `tmuxy.compat.conf`     | data   | tmuxy | no           | no              | Only while your `tmuxy.conf` still sources the old defaults: a copy without that line. |
| `tmuxy.conf.example`    | data   | tmuxy | no           | no              | The starter `tmuxy.conf`; `tmuxy config init` copies it into the config dir.           |
| `themes/<built-in>.css` | data   | tmuxy | no           | no              | The bundled themes, to read or copy.                                                   |
| `bin/`                  | data   | tmuxy | no           | no              | The `tmuxy` CLI and its helper scripts.                                                |
| `README.md`             | data   | tmuxy | no           | no              | This file.                                                                             |
| `tmuxy.state.json`      | state  | tmuxy | no           | no              | Choices made in the app's menus (theme, mode, cursor blink, `use-tmux-conf`).          |
| `servers.json`          | state  | tmuxy | yes          | no              | The servers `tmuxy session connect` saved; ssh hosts as this machine reaches them.     |
| `trace.json`            | state  | tmuxy | yes          | no              | The Debug menu's trace switch.                                                         |
| `launcher`              | state  | tmuxy | no           | no              | The path of the desktop app the `~/.local/bin/tmuxy` shorthand runs.                   |
| `tmuxy.pid`             | state  | tmuxy | no           | no              | The running web server's pid (`tmuxy-<port>.pid` on another port).                     |
| `config-reload`         | state  | tmuxy | no           | no              | Touched by `tmuxy config reload`; the app re-sources the chain when it changes.        |

## The config chain

tmux starts with `tmuxy.entry.conf`, which sources, in order:

1. `tmuxy.essentials.conf` — first, so the command-aliases every binding uses exist.
2. `tmuxy.defaults.conf` — tmuxy's taste.
3. `~/.tmux.conf` — only after `tmuxy config use-tmux-conf on`.
4. your `tmuxy.conf` — your overrides; no `source-file` line needed.
5. `tmuxy.essentials.conf` again — so no config can take the app apart.

## Config beats menu state

A menu choice (the Theme menu, Blinking Cursor, Ask Before Sending Keys,
Enable Window Transparency) is remembered in `tmuxy.state.json` and put back
after the chain on every start. An option your `tmuxy.conf` sets is **pinned**
instead: the menu shows it as "set in tmuxy.conf" and cannot change it, and
the remembered choice is not put back over it. That holds for
`@tmuxy-theme`, `@tmuxy-theme-mode`, `@tmuxy-transparency`,
`@tmuxy-cursor-blink` and `@tmuxy-send-ask`. To pin a theme on every machine
that shares your dotfiles:

    set -g @tmuxy-theme nord

To hand the choice back to the menu, delete the line.

## Themes

A theme is one CSS file that sets the `--*` variables the UI reads:
`--term-*` (the 16 ANSI colours, foreground, background), `--bg-*`
(surfaces), `--text-*`, `--border-*`, `--accent-*`, `--link-*`, `--error-*`.
The variable names are stable across releases; copy any built-in theme to see
the full list. The built-ins are in the data dir's `themes/`; yours go in the
config dir's `themes/`.

To make your own:

    mkdir -p ~/.config/tmuxy/themes
    cp ~/.local/share/tmuxy/themes/nord.css ~/.config/tmuxy/themes/mine.css

Edit `mine.css`, pick **Mine** in the Theme menu, and every save repaints the
open windows. Saved as `nord.css` instead, it replaces the built-in Nord. Do
not edit a built-in file: it is read-only and rewritten on every launch.

A theme declares a palette per mode in a `:root.theme-dark { … }` block and a
`:root.theme-light { … }` block. The Theme menu greys out a mode the current
theme has no block for. **System** follows the operating system's dark/light
setting.

## Small tweaks without a theme

Two ways, from the most specific down:

1.  `custom.css` — any CSS, loaded after the theme. For a font size, a hidden
    header, a tab-strip tweak. The `--*` variables are a stable contract; the
    class names under them are not, and a release may rename one. Set a
    variable the way the themes do, so it outranks them:

        :root.theme-dark, :root.theme-light {
          --term-background: #101010;
        }

2.  `@tmuxy-css-<variable>` in `tmuxy.conf` — one variable, set like any tmux
    option, so a script or an agent can change it from a pane:

        set -g @tmuxy-css-term-background '#101010'
        set -g @tmuxy-css-accent-blue '#7aa2f7'

    The name is the variable without its `--`; the value is one CSS value.
    A value holding a comment, a backslash, or `url(` (anything that fetches)
    is ignored; put those in `custom.css`.

Precedence, top wins: `custom.css` → `@tmuxy-css-*` → the theme file. The
three are loaded in the opposite order, so at equal specificity the later one
wins — which is why `custom.css` wants the selector above.

## The `@tmuxy-*` options

Set these in `tmuxy.conf` with `set -g`, then `tmuxy config reload` (or just
save the file). Opacities are 0.0–1.0; switches take `on`/`off`.

| Option                          | Default  | What it does                                                                                                                                                                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@tmuxy-theme`                  | default  | The theme's file stem under `themes/`.                                                                                                                                                                              |
| `@tmuxy-theme-mode`             | dark     | `dark`, `light` or `auto` (follow the OS).                                                                                                                                                                          |
| `@tmuxy-opacity`                | 0.7      | Window chrome: title bar, sidebar, the gaps between panes.                                                                                                                                                          |
| `@tmuxy-active-pane-opacity`    | 1        | The active pane's background.                                                                                                                                                                                       |
| `@tmuxy-inactive-pane-opacity`  | 0.7      | Every other pane's background.                                                                                                                                                                                      |
| `@tmuxy-active-text-opacity`    | 1        | The active pane's header and text.                                                                                                                                                                                  |
| `@tmuxy-inactive-text-opacity`  | 0.7      | Every other pane's header and text — the focus cue.                                                                                                                                                                 |
| `@tmuxy-blur`                   | on       | Native blur behind the window (macOS; ignored elsewhere).                                                                                                                                                           |
| `@tmuxy-transparency`           | on       | Off: opaque window, no blur (View ▸ Enable Window Transparency).                                                                                                                                                    |
| `@tmuxy-animations`             | on       | Layout animations: pane morphs, swaps, resizes, float keyframes.                                                                                                                                                    |
| `@tmuxy-cursor-blink`           | on       | Blinking cursor, unless an application asks for a steady one.                                                                                                                                                       |
| `@tmuxy-send-ask`               | on       | `tmuxy pane send` into another pane asks there first.                                                                                                                                                               |
| `@tmuxy-send-allow`             | —        | Callers (`claude,codex`) and panes (`%3,%5`) that never ask.                                                                                                                                                        |
| `@tmuxy-tab-overview-cols`      | 3        | Cards per row in the "all tabs" view, 1–12.                                                                                                                                                                         |
| `@tmuxy-gesture-swipe-tabs`     | on       | Two-finger slide left/right switches tabs, whatever macOS's swipe setting.                                                                                                                                          |
| `@tmuxy-gesture-pinch-zoom`     | on       | Pinch out zooms a pane, pinch in unzooms it.                                                                                                                                                                        |
| `@tmuxy-gesture-pinch-overview` | on       | Pinch in on an unzoomed tab opens the "all tabs" view.                                                                                                                                                              |
| `@tmuxy-native-menus`           | on       | Desktop app: native menu bar and popups; off keeps the in-app menus.                                                                                                                                                |
| `@tmuxy-size`                   | smallest | Grid size across clients: `smallest`, `largest`, `latest`, or a fixed `COLSxROWS` (`80x25`). Every size but `smallest` scales each client's grid to fit; a fixed one also keeps its cols/rows when a sidebar opens. |
| `@tmuxy-css-<variable>`         | —        | One CSS variable, see above.                                                                                                                                                                                        |

## Your own `~/.tmux.conf`

tmuxy starts tmux with its own config, so your prefix, status line and
plugins are not loaded by default. To bring them in:

    tmuxy config use-tmux-conf on

That sources `~/.tmux.conf` after tmuxy's defaults and before your
`tmuxy.conf`, then re-applies `tmuxy.essentials.conf` on top: your settings win
except where they would stop tmuxy working. It takes effect the next time
tmuxy connects to its tmux server.

## Applying a change

| You changed                       | What applies it                                                           |
| --------------------------------- | ------------------------------------------------------------------------- |
| a file in `themes/`, `custom.css` | nothing — saving the file repaints every open window                      |
| `tmuxy.conf`                      | saving the file, or `tmuxy config reload` — the whole chain is re-sourced |
| the theme or mode                 | the Theme menu, or `set -g @tmuxy-theme <name>` in `tmuxy.conf` (a pin)   |
| `use-tmux-conf`                   | the next connect to tmuxy's tmux server                                   |

## Starting over

`tmuxy config init` writes the starter `tmuxy.conf` into the config dir when
there is none (it never overwrites one). tmuxy itself writes it only on the
very first run, so a `tmuxy.conf` you deleted stays deleted and tmuxy runs on
its defaults.

## Upgrading from a build that kept everything in `~/.config/tmuxy`

The first launch of a build with this layout moves the state files to the
state dir, removes the files it used to mirror into the config dir (the data
dir has them now), and drops from `tmuxy.conf` the blocks older builds wrote
there: the old header, the `source-file …/tmuxy.defaults.conf` line, the
commented examples, the Ctrl+Tab lines "added by tmuxy upgrade" and a
Ctrl+hjkl restore the defaults now ship. The original is kept beside it as
`tmuxy.conf.bak`. Nothing is written or deleted through a symlink: a linked
`tmuxy.conf` is left as it is, and one that still sources the old defaults
keeps working.
