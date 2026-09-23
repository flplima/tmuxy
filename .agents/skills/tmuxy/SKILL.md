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
tmuxy widget browser <file|url> # show an HTML file, a site, a .md file or an image
tmuxy event emit <name> <msg|-> # publish to a named queue (inter-agent coordination)
tmuxy event wait <name>         # block until a message arrives; `event list` shows pending
tmuxy run <tmux cmd>            # any tmux command, routed safely through run-shell
```
