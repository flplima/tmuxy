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
   which wraps mutations in `tmux run-shell`. Escape hatch: `tmuxy run <any tmux cmd>`.
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
tmuxy pane list --json          # id, tab, width, height, command, active (--all = every tab)
tmuxy pane split [-h|-v] [--json] # split pane (returns %id or JSON)
tmuxy pane float [opts] [cmd]   # open a float
tmuxy pane capture [%id] --json # read what's on a pane's screen
tmuxy pane send ls Enter        # type into a pane
tmuxy pane select -U|-D|-L|-R|%id # select pane
tmuxy pane kill [%id]           # close pane
tmuxy tab list --json           # tabs; also kill/select/next/prev/rename/layout
tmuxy tab create [name] [--json]# create tab (returns @id or JSON)
tmuxy pane group add            # group the current pane (members become header tabs)
tmuxy pane group join %id %m    # put %id in %m's group; also move, leave, switch, next, prev, close
tmuxy pane send -t %id <keys...># type into another pane; the user allows it there first (blocks until answered)
tmuxy session save [name]       # snapshot a session; also restore <name>, snapshots, forget <name>
tmuxy open <file|url|host>      # show an HTML file, a site, a .md file or an image
tmuxy widget browser <file|url> # the same, spelled out
tmuxy browser [url]             # a real browser drawn in the pane; `:` verbs drive it (see below)
tmuxy browser --attach[=ENDPOINT] # the same, on a browser already running (your own profile)
tmuxy run <tmux cmd>            # any tmux command, routed safely through run-shell
tmuxy config reload             # re-apply ~/.config/tmuxy/tmuxy.conf to the running app
```

## Driving a browser pane

`tmuxy browser [url]` turns a pane into a real browser (your own Chrome/Chromium/Edge/
Brave, drawn as a picture). `--attach` drives a browser that is already running — with
no endpoint it finds one by itself (a profile's `DevToolsActivePort`, else 127.0.0.1:9222);
Chrome 144+ exposes the user's own profile only after the consent prompt at
`chrome://inspect/#remote-debugging`. The picture only means something when the server is
the machine with the screen. Drive it from another pane, no API needed:

```sh
tmuxy pane send -t %ID ':goto example.com' Enter   # verbs: goto, eval, click, type, wait,
tmuxy pane send -t %ID ':eval document.title' Enter #   text, title, url, shot, back,
tmuxy pane capture %ID                             #   forward, reload, viewport, repl, help
```

Each verb answers on the pane's bottom row, which `tmuxy pane capture` reads back. `:repl`
(or the toolbar's REPL button) swaps the picture for the verb log, so the user can see what
you typed and what came back; `:repl off` brings the picture back.

## Personalizing tmuxy

Everything the user can change lives in `~/.config/tmuxy/`; its `README.md` is the
guide — read it before changing a theme, a colour or the tmux config. In short:

- Never edit an app-owned file (the built-in `themes/*.css`, `tmuxy.defaults.conf`):
  it is rewritten on every launch. Copy a theme to a new name instead.
- Small tweaks: `custom.css` (any CSS), or `set -g @tmuxy-css-<variable> <value>` in
  `tmuxy.conf`. Options are `@tmuxy-*` in `tmuxy.conf`; `tmuxy config reload` applies it.
- A saved theme or `custom.css` repaints every open window by itself.
