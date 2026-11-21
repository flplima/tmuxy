Small recipes for the things you will not find by clicking around. Each one is a line or a gesture.

Recipes marked _On main, not in a release yet_ need a build newer than `v0.1.6`.

## Layout

### Run a command in a float that closes with it

```sh
tmuxy pane float htop
```

The float opens over the tab. When `htop` exits, the float goes away. Add `--right` or `--bottom` for a drawer docked to that edge, and `--width 80` or `--height 20` to size it.

### Zoom a pane with a double-click

Double-click a pane's header to zoom it. Double-click again to put it back. From the keyboard it is `prefix z`. On a trackpad in the desktop app, pinch.

### Move a pane to another tab by dragging it

Drag a pane's header onto a tab in the strip to join that tab. Drag it onto the empty part of the strip to give it a tab of its own. In the keyboard's PANE mode, `g` joins a pane from another tab and `b` breaks the pane out.

### Group panes as header tabs

```sh
tmuxy pane group all        # every pane in this tab becomes one group
tmuxy pane group ungroup    # and back out into splits
```

`prefix =` adds a new pane to the current pane's group. You can also drag a pane onto another pane's header.

### Try a preset layout

```sh
tmuxy tab layout tiled      # also: next, even-h, even-v, main-h, main-v
```

### See every tab at once

Press `Ctrl+0` (or `prefix w`). Click a tab to go there. The grid has 3 columns by default. Change it with `set -g @tmuxy-tab-overview-cols 4` in `tmuxy.conf`.

### Jump anywhere, or make a session from a new name

_On main, not in a release yet._

Press `prefix g` and type a few letters of a session, tab or pane. Type `>` to bring the actions back. A name no session has can become a new session from the same box.

## Agents

### Run a command and branch on its result

```sh
if tmuxy pane run --wait -- npm test; then echo green; else echo red; fi
```

The command runs in a new pane. `--wait` blocks until it exits and returns its exit status. Add `--for 10m` to give up after ten minutes.

### Name a pane, then talk to it by name

```sh
tmuxy pane run --label logs --focus=false -- tail -f app.log
tmuxy pane capture logs --trim      # what it shows now
tmuxy pane send -t logs C-c         # asks you first, since it is another pane
```

A label works anywhere a pane id does. A label that names no pane, or more than one, changes nothing and exits 3.

### Show what your coding agent is doing

```sh
tmuxy agent install
```

This adds hooks for Claude Code, Codex and Antigravity. Their rows in the tree then say working, waiting for you, done or failed. See [[AI Agents]].

### Let a script ask you a question

_On main, not in a release yet._

```sh
tmuxy pane ask "Deploy to production?" --choice deploy --choice cancel
```

The question shows on every client you have open. The first answer wins and prints on stdout.

### Start an agent and wait for it

_On main, not in a release yet._

```sh
tmuxy agent spawn --label review --prompt "Review the last commit"
tmuxy agent wait review --for 30m
```

The agent gets a pane in your tab and the focus stays with you. `wait` returns when it stops: idle, needs input, error or done.

## Remote

### Reach your server through an SSH tunnel

```sh
ssh -NL 9000:localhost:9000 user@host
```

Then open `http://localhost:9000`. The server stays on loopback, and SSH does the encryption. This is the safest way. See [[Remote Access]].

### Put a password on a server you open to a network

```sh
TMUXY_PASSWORD=choose-a-long-one tmuxy server --host 0.0.0.0
```

Use it on a VPN or a LAN you trust. Plain HTTP means the password travels in the clear. Never open it to the internet. See [[Security]].

### Show your own tmux sessions in the browser

```sh
TMUX_SOCKET=default tmuxy server
```

By default tmuxy runs on a socket of its own, so your everyday sessions stay out of sight. This points the web server at your own tmux server. In the desktop app, pick **my tmux** in the session menu.

### Keep a session's shape across a restart

```sh
tmuxy session save                      # snapshot now (it also saves on every change)
tmuxy session snapshots                 # list them
tmuxy session restore work --run        # rebuild "work" and run each pane's program
tmuxy pane restore-cmd 'claude --resume' # tell this pane how to come back
```

A snapshot keeps tabs, splits, floats and each pane's folder and program. It does not resume running processes. Without `--run`, each program comes back typed at the prompt, not run.

## Shell

### Preview a markdown file or a page in a pane

```sh
tmuxy open notes.md
```

The preview follows the file as it changes. With no argument, it opens `index.html` or `README.md` from the current folder. A page is offline unless you pass `--net`.

### Find out where a key comes from

```sh
tmuxy keymap --table prefix t
```

_On main, not in a release yet._ It prints the binding and the file and line that set it. `tmuxy keymap` alone lists them all, including keys from plugins.

### Fix a config that stops loading

```sh
tmuxy config doctor          # list source-file lines whose file is missing
tmuxy config doctor --fix    # comment them out, keep a dated backup
```

A missing `source-file` target makes tmux stop reading the config at that line.

### Use your own tmux.conf too

```sh
tmuxy config use-tmux-conf on
```

By default tmuxy does not read `~/.tmux.conf`. With this on, your prefix, status line and plugins come back. tmuxy then restores the few settings it needs. It takes effect the next time tmuxy connects.

### Copy what the last command printed

_On main, not in a release yet._ Open the pane menu and pick **Copy Last Output**. It needs a shell that marks its prompts (OSC 133) and tmux 3.4 or newer.

### Search the scrollback

_On main, not in a release yet: the search over the whole history._

Enter copy mode (`prefix [`), then press `/` to search down or `?` to search up. `n` and `N` jump between matches. tmuxy has no Cmd+F find, on purpose. See [[Copy Mode and Scrollback]].

## Looks

### Pin an option so the menus leave it alone

```tmux
# in ~/.config/tmuxy/tmuxy.conf
set -g @tmuxy-theme nord
set -g @tmuxy-cursor-blink off
```

An option you set in `tmuxy.conf` is pinned. The menu greys it out and says "set in tmuxy.conf". Saving the file applies it at once.

### Make inactive panes fade

```tmux
set -g @tmuxy-inactive-pane-opacity 0.6
```

### Change one colour without writing a theme

```tmux
set -g @tmuxy-css-theme-accent '#7aa2f7'
```

For more, write `~/.config/tmuxy/custom.css`. It wins over a theme and over `@tmuxy-css-*`. See [[Themes and Appearance]].

### Swap the prefix

```tmux
unbind C-a
set -g prefix C-Space
bind C-Space send-prefix
```

## See also

- [[Keybindings]]
- [[Configuration]]
- [[Scripting with the CLI]]
- [[FAQ]]
