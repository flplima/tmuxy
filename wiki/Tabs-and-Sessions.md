Tabs are tmux windows. Sessions hold tabs and survive closing the app. This page covers both, plus snapshots and other servers.

## Tabs

| What    | Mouse / Menu                                    | Key                                                | CLI                                                                       |
| ------- | ----------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| New tab | the strip's `+`, or Tab ▸ New Tab               | `prefix c`                                         | `tmuxy tab create [name]`                                                 |
| Switch  | click a tab, or slide two fingers on a trackpad | `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+1` to `Ctrl+9` | `tmuxy tab select <index\|@id\|name>`, `tmuxy tab next`, `tmuxy tab prev` |
| Rename  | rename in the strip, or Tab ▸ Rename Tab        | `prefix t`, then `,`                               | `tmuxy tab rename <name>`                                                 |
| Close   | the tab's ✕, or Tab ▸ Close Tab                 | `prefix t`, then `x`                               | `tmuxy tab kill [@id]`                                                    |
| Reorder | drag a tab along the strip                      | `prefix t`, then `<` or `>`                        | none                                                                      |
| List    | the strip, the tree sidebar                     |                                                    | `tmuxy tab list`                                                          |

`Ctrl+1` to `Ctrl+9` go by position in the strip. The menu also has Next Tab, Previous Tab and Last Tab.

## TAB mode

Press `prefix t` and the status line shows TAB mode. One plain key runs an action and returns to normal mode. `Esc` leaves without doing anything.

| Key        | Action                    |
| ---------- | ------------------------- |
| `h` / `l`  | Previous / next tab       |
| `c`        | New tab                   |
| `,`        | Rename                    |
| `x`        | Close                     |
| `1` to `9` | Go to tab 1 to 9          |
| `<` / `>`  | Move the tab left / right |
| `o`        | Show every tab (overview) |

The full tables are on [[Keybindings]].

## See every tab at once

Click the grid button, press `Ctrl+0`, or pinch in on an unzoomed tab on a trackpad. `prefix w` and TAB mode's `o` open it too. Tab ▸ Show All Tabs does the same.

The overview shows each tab as a card. Cards per row is `@tmuxy-tab-overview-cols` (1 to 12, default 3, at most 2 on a phone-width window).

## Preview a tab on hover

Rest the pointer on a tab in the strip and a preview of that tab appears. No click needed.

## Preset layouts

```bash
# Cycle to the next layout, or name one.
tmuxy tab layout next
tmuxy tab layout even-h
```

The names are `next`, `even-h`, `even-v`, `main-h`, `main-v` and `tiled`. In the app they are in the View menu: Even Horizontal, Even Vertical, Main Horizontal, Main Vertical and Tiled.

## Sessions

The Session menu has New Session, Rename Session, Detach Session and Kill Session. Detach only works in the desktop app. Kill asks first.

```bash
# Create a detached session. With no name it gets one like quiet-meadow.
tmuxy session new work --cwd ~/projects

# Rename the session you are in, or another one.
tmuxy session rename new-name
tmuxy session rename old-name new-name

# Kill a session by name. The name is required on purpose.
tmuxy session kill work

# Open the interactive switcher.
tmuxy session switch
```

To switch in the app, click the title at the top of the tree sidebar. A dropdown lists the sessions, with a box to filter as you type. A name no session has can become a new one from the palette (see [[Sidebars Palette and Inbox]]).

`tmuxy session new` takes `-- command...` to run something in the first pane instead of the shell. A name a session already has exits 1 and creates nothing.

## Snapshots

tmuxy saves each session's shape on every change: tabs, splits, floats, sidebars, groups, and each pane's directory and program. If the server starts and the session is gone, tmuxy rebuilds it.

Programs come back typed at the prompt, not run. A banner on the pane offers to run it. Add `--run` to the CLI to run them.

```bash
# Save now (the autosave does this on every change).
tmuxy session save work
tmuxy session save work --scrollback 2000   # also keep the last 2000 lines per pane

# See which sessions have a snapshot.
tmuxy session snapshots

# Bring one back. It refuses a session that is running.
tmuxy session restore work
tmuxy session restore work --run

# Delete a session's snapshots.
tmuxy session forget work
```

`tmuxy session kill` keeps the snapshot, so you can restore after a kill. `forget --force` also kills a running session. The Session menu has restore items too.

To start a missing session empty even when a snapshot exists, start the server with `--no-restore` or set `TMUXY_NO_RESTORE=1`.

A program can say how it should come back with `tmuxy pane restore-cmd '<command>'`.

## Attach to another tmux server

tmuxy runs on its own tmux socket (`tmuxy`). To use another server, including one over SSH, run:

```bash
# Asks which machine, checks tmux is there, saves it, and attaches.
tmuxy connect
```

You can also use the splash form on a new window, or Connect over SSH in the session switcher. The desktop app keeps the servers you saved in its list.

| Command                                                           | What it does                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------- |
| `tmuxy session connect [<dest>] [--socket NAME] [--session NAME]` | Connect to `[user@]host` (or `localhost`) and attach |
| `tmuxy connect default`                                           | Point the desktop app at your everyday tmux server   |
| `tmuxy connect default work`                                      | The same, on its `work` session                      |
| `tmuxy connect /tmp/tmux-1000/foo`                                | A socket by full path                                |

`tmuxy connect <socket>` only affects the desktop app. The web server binds its socket at launch, so start it with `TMUX_SOCKET=default tmuxy server` instead.

The first time tmuxy starts while your own tmux has sessions, it tells you once. The session menu then lists **my tmux** under Servers.

## Several windows on one session

In the desktop app, Window ▸ New Window (`Cmd+N`, or `Ctrl+Shift+N` off macOS) opens another OS window. Each window can sit on its own tab of the same session. `Cmd+1` to `Cmd+9` (`Ctrl+Shift+1` to `9` off macOS) focus a window.

When windows of different sizes watch one session, `@tmuxy-size` sets the grid size. Use `smallest` (the default), `largest`, `latest`, or a fixed `COLSxROWS` like `80x25`.

## When the connection drops

If the connection to the server drops, an overlay says so and tmuxy reconnects. Your panes keep running in tmux.

## See also

- [[Panes Groups and Floats]]
- [[Sidebars Palette and Inbox]]
- [[Desktop or Web]]
- [[Remote Access]]
