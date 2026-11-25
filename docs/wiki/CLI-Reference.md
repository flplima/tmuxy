Every `tmuxy` command and flag, in the order `tmuxy --help` lists them. Run `tmuxy <command> --help` for the live text.

Commands and flags marked **(main)** are on `main` and not in a release yet. `[x]` is optional, `<x>` is required, `a|b` is a choice.

## Common to every command

### Targets

A pane is named by its tmux id (`%3`) or by a label. A label is the `@tmuxy-label` option (set with `tmuxy pane run --label logs`) or the pane's title. A label that names no pane, or more than one, changes nothing and exits 3. The default target is the pane the command runs in.

A tab is named by its `@id`, its index or its name.

### `--json`

`--json` works on every command. Queries keep their shape. A mutation answers `{"ok":true,...}` with the ids it made. A failure answers `{"ok":false,"error":"...","code":N}` and sets the exit code below.

### Exit codes

| Code  | Meaning                                                                      |
| ----- | ---------------------------------------------------------------------------- |
| `0`   | ok                                                                           |
| `1`   | failed: tmux refused, the user declined, a wait timed out                    |
| `2`   | bad command line: unknown command, bad flag, missing argument                |
| `3`   | target not found, or a label naming more than one pane                       |
| `4`   | no tmux server on the socket                                                 |
| `5`   | sent, but what was waited for afterwards did not happen (`pane send --wait`) |
| `130` | interrupted                                                                  |

`pane run --wait` and `pane wait` exit with the program's own status.

### Global options

| Flag              | Meaning                          |
| ----------------- | -------------------------------- |
| `-h`, `--help`    | Show help                        |
| `-V`, `--version` | Show the version                 |
| `--json`          | Answer in JSON, on every command |

## info

`tmuxy info [--json]`: show multiplexer and session status.

## skill

`tmuxy skill`: print the AI agent guide and safety rules.

## agent

Set up coding agents, and start, wait for, revive and fork agents in panes. See [[CLI Reference agent plugin server]].

## pane

Manage panes: split, kill, select, resize, group, float, run, send, capture. It has a page of its own: [[CLI Reference pane]].

## tab

| Command                                                          | What it does           |
| ---------------------------------------------------------------- | ---------------------- |
| `tmuxy tab list [--json]`                                        | List all tabs          |
| `tmuxy tab create [name] [--json]`                               | Create a new tab       |
| `tmuxy tab kill [target]`                                        | Kill a tab (`@id`)     |
| `tmuxy tab select <index\|@id\|name>`                            | Switch to a tab        |
| `tmuxy tab next`                                                 | Next tab               |
| `tmuxy tab prev`                                                 | Previous tab           |
| `tmuxy tab rename <name>`                                        | Rename the current tab |
| `tmuxy tab layout [next\|even-h\|even-v\|main-h\|main-v\|tiled]` | Change the pane layout |

## session

A session's shape (tabs, splits, floats, sidebars, groups, each pane's folder and program) is saved on every change. It comes back when the server starts and the session is gone. Programs come back typed at the prompt, not run. `--run` runs them.

| Command                                                               | What it does                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tmuxy session new [name] [--cwd DIR] [-- command...]` **(main)**     | Create a detached session. With no name it gets one like `quiet-meadow`. An existing name exits 1 |
| `tmuxy session rename [session] <new-name>` **(main)**                | Rename a session. With one argument, the one you are in                                           |
| `tmuxy session kill <session>` **(main)**                             | Kill a session and every pane in it. The name is required. Its snapshot stays                     |
| `tmuxy session switch`                                                | Interactive session switcher                                                                      |
| `tmuxy session connect [<dest>] [--socket <name>] [--session <name>]` | Connect to a server on `[user@]host` (or `localhost`) and attach. Default socket: `tmuxy`         |
| `tmuxy session save [name] [--scrollback N]`                          | Snapshot a running session now. `--scrollback N` also keeps the last N lines of every pane        |
| `tmuxy session restore <name> [--run]`                                | Rebuild a session from its latest snapshot. Refuses a running session                             |
| `tmuxy session snapshots`                                             | The sessions that have a snapshot, and when it was taken                                          |
| `tmuxy session forget <name> [--force]`                               | Delete a session's snapshots. `--force` kills a running session first                             |

`session new` takes `--cwd DIR` (exit 2 when it is no folder). `session save` with no name uses `TMUXY_SESSION`, then `tmuxy`. `tmuxy session kill` and `tmuxy session new` answer `{"ok":true,"session":"<name>"}` under `--json`.

## nav

`tmuxy nav <direction>`

| Direction    | What it does                                                        |
| ------------ | ------------------------------------------------------------------- |
| `left`       | Previous group member, then pane to the left, then the left sidebar |
| `right`      | Next group member, then pane to the right, then the right sidebar   |
| `up`, `down` | Pane splits only (vertical)                                         |
| `next`       | Sequential forward, same as `right`                                 |
| `prev`       | The last pane, falling back to the last window                      |

## widget

| Command                                            | What it does                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `tmuxy widget tree`                                | Show the tabs and panes tree (the left sidebar's content)                               |
| `tmuxy widget preview [--net] [--no-theme] [file]` | Show a local `.html` or `.md` file, kept up to date as it changes. Same as `tmuxy open` |

## open

`tmuxy open [--net] [--no-theme] [file]`: preview a local `.html`, `.htm`, `.md` or `.markdown` file in this pane. With no file, it opens the first of `index.html`, `README.md` or `readme.md` in the current folder.

| Flag         | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `--net`      | Let a page load from the network. Off, the page is offline and only what sits beside it shows |
| `--no-theme` | Draw the page in its own colors, not the theme's                                              |

## mcp

`tmuxy mcp [--port N] [--host H] [--session NAME] [--read-only] [--json]`

Prints the MCP endpoint of a running `tmuxy server` and how to add it to an MCP client. See [[MCP]].

| Flag               | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `--port <N>`       | The server's port. Default `9000`                      |
| `--host <H>`       | The server's address. Default `127.0.0.1`              |
| `--session <NAME>` | The session to drive. Default: the one this pane is in |
| `--read-only`      | Only the tools that change nothing                     |

## run

`tmuxy run <tmux-command> [args...]`: run a tmux command that reads, arranges or closes panes and windows, safely through `run-shell`.

It runs these, by full name or alias: `break-pane`, `capture-pane`, `clear-history`, `clock-mode`, `copy-mode`, `delete-buffer`, `display-message`, `has-session`, `join-pane`, `kill-pane`, `kill-server`, `kill-session`, `kill-window`, `last-pane`, `last-window`, `link-window`, `list-buffers`, `list-clients`, `list-commands`, `list-keys`, `list-panes`, `list-sessions`, `list-windows`, `move-pane`, `move-window`, `next-layout`, `next-window`, `previous-layout`, `previous-window`, `rename-session`, `rename-window`, `resize-pane`, `rotate-window`, `select-layout`, `select-pane`, `select-window`, `show-buffer`, `show-environment`, `show-hooks`, `show-messages`, `show-options`, `show-prompt-history`, `show-window-options`, `swap-pane`, `swap-window`, `unlink-window`.

It refuses everything else:

- keys into any pane: use `tmuxy pane send`
- commands that run a shell or keep a command for later (`run-shell`, `if-shell`, `split-window`, `new-session`, `bind-key`, `display-popup` and so on): use `tmuxy pane split`, `pane run` or `tab create`
- writes to an option, hook or the environment (`set-option`, `set-hook`, `set-environment`, `source-file`)
- an argument ending in `;`, and a format that runs a shell (`#(…)`, or the `E:` and `T:` modifiers)
- `resize-window`

`new-window` is intercepted and becomes `tmuxy tab create`.

```sh
tmuxy run list-panes -F '#{pane_id} #{pane_current_command}'
tmuxy run copy-mode -q      # leave copy mode
```

## cleanup

`tmuxy cleanup [-n|--dry-run] [-q|--quiet]`: reap shells left hanging by a pane that died while its shell was still starting. Each one holds a PTY open, and enough of them exhaust the machine's pseudoterminals.

| Flag              | Meaning                            |
| ----------------- | ---------------------------------- |
| `-n`, `--dry-run` | List what would be reaped and exit |
| `-q`, `--quiet`   | Print nothing                      |

## connect

`tmuxy connect [socket] [session]`

With no arguments, it runs `tmuxy session connect`: asks which machine to use (this one, or `[user@]host` over SSH), checks tmux is reachable, saves the server to the desktop app's list and attaches. With a socket, it reconnects the desktop app to a different tmux server without relaunching. `socket` is a name in tmux's default folder (`default` is your everyday server) or a full path containing a slash. It has no effect in the web UI.

```sh
tmuxy connect default            # attach to your everyday tmux server
tmuxy connect default work       # ...to its "work" session
tmuxy connect /tmp/tmux-1000/foo # a socket by full path
```

## server

Run the web server, and install it as a service. See [[CLI Reference agent plugin server]].

## trace

`tmuxy trace [flags] [FILE]`: inspect a local action trace. With no flag, it prints a summary. FILE defaults to `trace.ndjson` in the state folder. See [[Troubleshooting]].

| Flag                  | Meaning                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `--export <PATH>`     | Write a Chrome-trace/Perfetto timeline to this path. Open it at ui.perfetto.dev                 |
| `--mark <LABEL>`      | Append a marker line with this label, then exit                                                 |
| `--health`            | A field health check: reconnects, rejected commands, anomalies                                  |
| `--github`            | With the health check: print findings as GitHub Actions annotations                             |
| `--window <MARK>`     | Read only the events from the latest such marker to the next                                    |
| `--last <N>`          | Read only the last N actions, printed as NDJSON                                                 |
| `--redact` **(main)** | Replace session names, paths, error text, command arguments and marker labels with placeholders |
| `--json`              | `{"ok":true,"output":…}`                                                                        |

## config

`tmuxy config <setting> [value]`

| Setting                                                                | What it does                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `reload`                                                               | Re-apply the config to the running app. Refused while tmux cannot parse your config                                              |
| `check [file] [--json]` **(main)**                                     | What is wrong with your config, with file and line, without applying it. Exit 1 when there is anything                           |
| `use-tmux-conf [on\|off]`                                              | Source your own `~/.tmux.conf` on tmuxy's socket. With no value, prints the current setting                                      |
| `init`                                                                 | Write the starter `tmuxy.conf` into the config folder. Refuses to overwrite one                                                  |
| `paths [--json]`                                                       | Every file tmuxy reads or writes: its owner, where it is, and whether it is safe to edit or symlink                              |
| `doctor [--fix] [--json]`                                              | List the `source-file` lines whose file is missing, exit 1. `--fix` comments each out and keeps a timestamped backup             |
| `permissions [--caller NAME] [--into PROGRAM] [-- KEYS...]` **(main)** | What `permissions.json` says. With keys, what typing them into another pane would get: allow, ask, deny or none. Nothing is sent |

Your files live in the config folder (`~/.config/tmuxy`), which tmuxy never writes after the first run. With `use-tmux-conf on`, your config is sourced after tmuxy's defaults and before your `tmuxy.conf`. It takes effect the next time tmuxy connects. See [[Configuration]].

## keymap

`tmuxy keymap [--table <TABLE>] [KEY] [--json]` **(main)**

Every key binding, and the file and line it comes from, including your own plugin's actions and verbs.

| Argument          | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `KEY`             | Only this key, as tmux names it (`t`, `C-a`, `M-Left`)          |
| `--table <TABLE>` | Only this key table (`prefix`, `root`, `pane`, `tab` and so on) |

## plugin

Install, list, update and remove plugins, and run their actions. See [[CLI Reference agent plugin server]].

## gui

`tmuxy gui`: open the desktop app on this socket's session.

## See also

- [[Scripting with the CLI]]
- [[Configuration]]
- [[Plugins]]
- [[Troubleshooting]]
