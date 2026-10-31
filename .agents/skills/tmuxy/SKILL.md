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
   which wraps mutations in `tmux run-shell`. Escape hatch: `tmuxy run <tmux cmd>`
   for commands that read, arrange or close panes and windows (`tmuxy run --help` lists
   them); it refuses keys, options, key bindings and anything that runs a shell — keys
   go through `pane send`.
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
tmuxy pane list --json          # id, tab, width, height, command, active, label (--all = every tab)
tmuxy pane split [-h|-v] [--json] # split pane (returns %id or JSON)
tmuxy pane run --wait -- npm test # run a command in a new pane and exit with ITS status
tmuxy pane run --label logs -- tail -f x.log  # keep it running; `-t logs` names it from now on
tmuxy pane wait <target> [--for 10m] # wait for the program in a pane; exit with its status
tmuxy pane float [opts] [cmd]   # open a float
tmuxy open <file.md|file.html>  # preview a markdown doc (mermaid too) or a page in this pane; follows the file, ctrl+c closes it
tmuxy pane capture [target] [--trim] [--unwrap] [--format text|vt|html] [--json] # a pane's screen
tmuxy pane send ls Enter        # type into a pane
tmuxy pane select -U|-D|-L|-R|target # select pane
tmuxy pane kill [target]        # close pane
tmuxy tab list --json           # tabs; also kill/select/next/prev/rename/layout
tmuxy tab create [name] [--json]# create tab (returns @id or JSON)
tmuxy pane group add            # group the current pane (members become header tabs)
tmuxy pane group join %id %m    # put %id in %m's group; also move, leave, switch, next, prev, close
tmuxy pane send -t <target> <keys...> # type into another pane; the user allows it there first (blocks until answered)
tmuxy session save [name]       # snapshot a session; also restore <name>, snapshots, forget <name>
tmuxy run <tmux cmd>            # a read/arrange/close tmux command, through run-shell
tmuxy config reload             # re-apply ~/.config/tmuxy/tmuxy.conf to the running app
```

## The contract for scripts

- **Wait, don't poll.** `tmuxy pane run --wait -- <cmd>` returns when the
  command exits, with its exit status, so a script can branch on it:
  `if tmuxy pane run --wait -- npm test; then ok; else failed; fi`.
  `tmuxy pane wait <target>` does the same for a pane that already runs
  something. Capture the screen afterwards, not in a loop.
- **Targets:** a pane id (`%3`) or a label — the `@tmuxy-label` set by
  `pane run --label`, else the pane's title. A label naming no pane or more
  than one changes nothing and exits 3. A tab is its `@id`, index or name.
- **`--json` on every command:** queries keep their shape; a mutation answers
  `{"ok":true,...}` with the ids it made; a failure is
  `{"ok":false,"error":"…","code":N}` on stdout, N being the exit code.
- **Exit codes:** 0 ok · 1 failed (tmux refused, user declined, a wait timed
  out) · 2 bad command line · 3 target not found or ambiguous · 4 no tmux
  server on the socket · 130 interrupted. A wait passes the program's status
  through.

## Personalizing tmuxy

Everything the user can change lives in `~/.config/tmuxy/`; its `README.md` is the
guide — read it before changing a theme, a colour or the tmux config. In short:

- Never edit an app-owned file (the built-in `themes/*.css`, `tmuxy.defaults.conf`):
  it is rewritten on every launch. Copy a theme to a new name instead.
- Small tweaks: `custom.css` (any CSS), or `set -g @tmuxy-css-<variable> <value>` in
  `tmuxy.conf`. Options are `@tmuxy-*` in `tmuxy.conf`; `tmuxy config reload` applies it.
- A saved theme or `custom.css` repaints every open window by itself.
