_Checked against herdr 0.9.5 (the version in its docs selector when I wrote this). Tell me if it has moved on._

herdr and tmuxy both want to be the place where you watch AI agents work. herdr is a multiplexer you run in your terminal, built around agents and the mouse. tmuxy is a GUI on top of tmux, so agents there are programs in ordinary tmux panes.

herdr's own docs: [herdr.dev/tui/docs](https://herdr.dev/tui/docs/), source at [github.com/herdrdev/herdr](https://github.com/herdrdev/herdr).

## Words: herdr to tmuxy

| herdr                            | tmuxy                                                 |
| -------------------------------- | ----------------------------------------------------- |
| workspace (one per repo or task) | session, the closest match                            |
| tab                              | tab                                                   |
| pane                             | pane                                                  |
| agent                            | a pane with a state (`tmuxy pane state`)              |
| `blocked`                        | `needs-input`                                         |
| `working`                        | `working`                                             |
| `done` (not yet viewed)          | `unread`                                              |
| `idle`                           | `idle`                                                |
| (none)                           | `error`                                               |
| session (a server namespace)     | a tmux socket, the closest match (`tmuxy` by default) |
| client and server                | the app or browser, and the tmuxy server on tmux      |
| prefix mode                      | the prefix (`Ctrl+a`)                                 |
| socket API                       | the CLI, `--json`, and the [[MCP]] endpoint           |
| plugins and marketplace          | [[Plugins]]                                           |

herdr finds agents by watching foreground processes and screens. tmuxy learns a pane's state from hooks you install with `tmuxy agent install`, from programs that report it themselves, or from screen rules for agents without hooks. See [[AI Agents]].

## Keys: herdr to tmuxy

herdr's prefix is `ctrl+b`. Defaults below come from its docs. Press `prefix+?` in herdr to see yours.

| Action                  | herdr                    | tmuxy                                  |
| ----------------------- | ------------------------ | -------------------------------------- |
| Split right             | `prefix+v`               | `prefix \|`                            |
| Split down              | `prefix+minus`           | `prefix -`                             |
| Close the pane          | `prefix+x`               | `prefix p` then `x`                    |
| New tab                 | `prefix+c`               | `prefix c`                             |
| Next, previous tab      | `prefix+n`, `prefix+p`   | `Ctrl+Tab`, `Ctrl+Shift+Tab`           |
| Focus a pane            | `prefix+h` `j` `k` `l`   | `Ctrl+h` `j` `k` `l`                   |
| Resize                  | `prefix+r` (resize mode) | `prefix H` `J` `K` `L`                 |
| Zoom a pane             | `prefix+z`               | `prefix z`                             |
| New workspace           | `prefix+shift+n`         | `tmuxy session new`, or Session menu   |
| Jump between workspaces | `prefix+w`               | `prefix g`, or the tree (`prefix s`)   |
| Detach                  | `prefix+q`               | Session menu, Detach Session (desktop) |
| Show all keys           | `prefix+?`               | `prefix ?`                             |

_`prefix g` and `prefix A` are on main, not in a release yet._

Both use the mouse a lot. In tmuxy you can drag dividers, drag panes between tabs and right-click for menus.

## What you gain

- **tmux underneath.** Your sessions, `~/.tmux.conf` (`tmuxy config use-tmux-conf on`) and tmux plugins still work.
- **A desktop app and a web app.** Open a session from a phone or tablet. This part is experimental.
- **An inbox across sessions.** `prefix A` lists every pane that needs you, and push notifications can reach your devices.
- **Safe sends between agents.** `tmuxy pane send` asks you before one agent types into another's pane. See [[Send Permissions]].
- **Floats and pane groups**, plus previews and inline images.

## What you give up

- **Agent detection out of the box.** herdr watches every pane. tmuxy wants a hook (`tmuxy agent install`), a program that reports its state, or a screen rule. See [[AI Agents]].
- **herdr's shape.** Workspaces, its configuration in TOML and its marketplace are herdr's own. tmuxy configures through tmux options and `tmuxy.conf`.
- **A terminal UI.** herdr runs inside your terminal. tmuxy is an app or a browser tab.
- **Windows.** tmuxy has no build for it.

herdr is built for this job. Detach and reattach, per-agent states and a socket API are all in its docs.

## Run both

tmuxy panes are real terminals, so you can start `herdr` in one. You will have two prefixes: `Ctrl+a` for tmuxy and `ctrl+b` for herdr.

```bash
# In a tmuxy pane
herdr
```

Or keep them apart. Run herdr in a terminal for one project, and tmuxy for the others.

## See also

- [[AI Agents]]
- [[Sub-agents]]
- [[Coming from tmux]]
