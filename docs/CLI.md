# CLI reference

Every `tmuxy` command and flag, in the order `tmuxy --help` lists them. This
file is generated from each command's own `--help`, so it cannot drift from
the CLI, and each help is shown verbatim in a `text` block: it is CLI output,
not code from the codebase. Do not edit it by hand: change the help text, then
run `node bin/ci/cli-reference.mjs` (`npm run check:policy` fails when this
doc differs from the help).

[FEATURES.md](FEATURES.md) is the catalog of what a user or an agent can do,
with the test that holds each capability; this is where each verb's flags are.
Commands whose help is long are in their own doc, linked below.

## `tmuxy`

```text
tmuxy — AI-first terminal multiplexer

Usage: tmuxy <command> [args...]

Commands:
  info        Show multiplexer and session status [--json]
  skill       Show AI agent guide and safety rules
  agent       Show Claude Code / Codex / Antigravity state in tmuxy (install, uninstall, status)
  pane        Manage panes (split, kill, select, resize, group, float)
  tab         Manage tabs (create, kill, select, rename, layout)
  session     Manage sessions (new, rename, kill, switch, connect, save, restore, snapshots, forget)
  nav         Navigate across groups, splits, and tabs
  widget      Display widgets (tree, preview)
  open        Preview a local .html or .md file in this pane (tmuxy widget preview)
  mcp         Show the MCP endpoint that lets an AI agent drive this session
  run         Run any tmux command safely
  cleanup     Reap shells left hanging by a pane that died while starting up
  connect     Reconnect the desktop app to a different tmux server (socket)
  server      Production server operations
  trace       Inspect/export a local action-trace file (docs/TRACING.md)
  config      Re-apply tmuxy.conf (reload), check it (doctor) or change a setting
  keymap      Every key binding, and the file and line it comes from [--table T] [key]
  plugin      Install, list, update and remove plugins; run their actions
  gui         Open the desktop GUI application

A plugin's own commands run as 'tmuxy plugin <verb>' ('tmuxy plugin list').

Options:
  -h, --help    Show this help
  -V, --version Show version
  --json        Answer in JSON, on every command: queries keep their shape,
                a mutation is {"ok":true,...} with the ids it made, a failure
                {"ok":false,"error":"...","code":N} (and the exit code below)

Targets:
  A pane is named by its tmux id (%3), or by a label: the @tmuxy-label option
  (tmuxy pane run --label logs) or the pane's title. A label naming no pane,
  or more than one, changes nothing (exit 3). A tab is its @id, index or name.

Exit codes:
  0    ok
  1    failed (tmux refused, the user declined, a wait timed out)
  2    bad command line (unknown command, bad flag, missing argument)
  3    target not found, or a label naming more than one pane
  4    no tmux server on the socket
  5    sent, but what was waited for after it did not happen (pane send --wait)
  130  interrupted
  'pane run --wait' and 'pane wait' exit with the program's own status.

Note for AI/LLM agents:
  • Do NOT run raw mutating tmux commands (external new-window/split-window crash control mode).
  • Always route mutations through 'tmuxy pane/tab/run'.
  • Use --json on query commands for unambiguous, parseable output.
  • Run a command and wait for it with 'tmuxy pane run --wait -- cmd' instead of
    polling 'pane capture'.
  • Run 'tmuxy skill' to print the full agent instruction guide.
```

## `tmuxy info`

```text
Usage: tmuxy info [--json]
```

## `tmuxy skill`

```text
Usage: tmuxy skill
```

## `tmuxy agent`

```text
Usage: tmuxy agent <install|uninstall|status> [claude|codex|agy|opencode|pi|crush]...
       tmuxy agent wait <pane>... [--until <states>] [--all] [--now] [--for 10m]
       tmuxy agent spawn [--agent claude|codex|gemini|cmd] [--label L] [--prompt TEXT]
                         [--place stack|split] [--permission-mode M] [-- cmd...]
       tmuxy agent start <label> [spawn's options] [--for 60s]
       tmuxy agent revive <pane>
       tmuxy agent fork <pane> [--branch B]

Show what a coding agent is doing on its tree row: working, waiting for you,
done, failed. Its lifecycle hooks report to tmuxy; the tmuxy skill is
installed alongside, so the agent knows the CLI. OpenCode, Pi and Crush
keep their hooks in code: they get the skill only.

  install     Add the hooks and the skill (default: every agent found)
  uninstall   Remove them, leaving everything else as it was
  status      Each item: current, outdated, missing, foreign, unsupported
  wait        Wait for agents in panes to stop: idle, needs input, error, done

Options:
  --hooks-only | --skill-only
  --project   This project's config (./.claude, ./.codex, ./.agents)
              instead of the home directory's
  --dry-run   Say what would change; write nothing
  --force     (install) Replace a tmuxy skill tmuxy did not write
```

## `tmuxy pane`

Manage panes (split, kill, select, resize, group, float)

Its subcommands and flags are in [CLI-PANE.md](CLI-PANE.md).

## `tmuxy tab`

```text
Usage: tmuxy tab <command> [args...]

Commands:
  list          List all tabs [--json]
  create        Create a new tab [name]
  kill          Kill a tab [@id]
  select        Switch to a tab <index|@id>
  next          Next tab
  prev          Previous tab
  rename        Rename current tab <name>
  layout        Change pane layout [next|even-h|even-v|main-h|main-v|tiled]
```

### `tmuxy tab list`

```text
Usage: tmuxy tab list [--json]
```

### `tmuxy tab create`

```text
Usage: tmuxy tab create [name] [--json]
```

### `tmuxy tab kill`

```text
Usage: tmuxy tab kill [target]
```

### `tmuxy tab select`

```text
Usage: tmuxy tab select <index|@id|name>
```

### `tmuxy tab next`

```text
Usage: tmuxy tab next
```

### `tmuxy tab prev`

```text
Usage: tmuxy tab prev
```

### `tmuxy tab rename`

```text
Usage: tmuxy tab rename <name>
```

### `tmuxy tab layout`

```text
Usage: tmuxy tab layout [next|even-h|even-v|main-h|main-v|tiled]
```

## `tmuxy session`

Manage sessions (new, rename, kill, switch, connect, save, restore, snapshots, forget)

Its subcommands and flags are in [CLI-SESSION.md](CLI-SESSION.md).

## `tmuxy nav`

```text
Usage: tmuxy nav <direction>

Directions:
  left        Previous group member → pane to the left → left sidebar
  right       Next group member → pane to the right → right sidebar
  up          Pane splits only (vertical)
  down        Pane splits only (vertical)
  next        Sequential forward (same as right)
  prev        Last pane, fall back to last window
```

## `tmuxy widget`

```text
Usage: tmuxy widget <command> [args...]

Commands:
  tree          Display the tabs+panes tree (the left sidebar's content)
  preview       Show a local .html or .md file, kept up to date as it
                changes [--net] [--no-theme] [file] (also: tmuxy open)
```

### `tmuxy widget tree`

```text
Usage: tmuxy widget tree
```

### `tmuxy widget preview`

```text
Usage: tmuxy widget preview [--net] [--no-theme] [file]

  file        an .html/.htm or .md/.markdown file; without one, the first of
              index.html, README.md or readme.md in the current directory
  --net       let a page load from the network (off: the page is offline,
              and only what sits beside it is shown)
  --no-theme  draw the page in its own colours, not the theme's
```

## `tmuxy open`

```text
Usage: tmuxy widget preview [--net] [--no-theme] [file]

  file        an .html/.htm or .md/.markdown file; without one, the first of
              index.html, README.md or readme.md in the current directory
  --net       let a page load from the network (off: the page is offline,
              and only what sits beside it is shown)
  --no-theme  draw the page in its own colours, not the theme's
```

## `tmuxy mcp`

```text
Usage: tmuxy mcp [--port N] [--host H] [--session NAME] [--read-only] [--json]

Print the MCP endpoint of a running `tmuxy server`, and how to add it to an
MCP client. Any MCP client (Claude Code, Cursor, Zed, ...) can then see and
drive the tmux session tmuxy shows: list, read, split, float and close panes,
open tabs and previews, and type into a pane once you allow it there.

Options:
  --port N        The server's port (default 9000)
  --host H        The server's address (default 127.0.0.1)
  --session NAME  The session to drive (default: the one this pane is in)
  --read-only     Only the tools that change nothing: eyes, no hands

The endpoint is served by `tmuxy server`, behind its password when it has one.
```

## `tmuxy run`

```text
Usage: tmuxy run <tmux-command> [args...]

Run a tmux command that reads, arranges or closes panes and windows,
safely through run-shell.

It runs these, by full name or alias (never a prefix):
  break-pane capture-pane clear-history clock-mode copy-mode delete-buffer
  display-message has-session join-pane kill-pane kill-server kill-session
  kill-window last-pane last-window link-window list-buffers list-clients
  list-commands list-keys list-panes list-sessions list-windows move-pane
  move-window next-layout next-window previous-layout previous-window
  rename-session rename-window resize-pane rotate-window select-layout
  select-pane select-window show-buffer show-environment show-hooks
  show-messages show-options show-prompt-history show-window-options
  swap-pane swap-window unlink-window

And refuses everything else:
  - keys into any pane, your own too (send-keys, paste-buffer, pipe-pane):
    use `tmuxy pane send`, which asks the user before typing into another
  - commands that run a shell or keep a command for later (run-shell,
    if-shell, split-window, new-session, respawn-pane, bind-key,
    command-prompt, display-popup, …): use `tmuxy pane split`, `pane run`,
    `tab create`
  - writes to an option, hook or the environment (set-option, set-hook,
    set-environment, source-file)
  - an argument ending in `;` (tmux starts another command there), and a
    format that runs a shell: `#(…)`, or the `E:` and `T:` modifiers
  - new-window is intercepted → `tmuxy tab create`
  - resize-window is blocked (unreliable with control mode attached)

Every argument reaches tmux quoted: `#{…}` formats are expanded by the
command they are given to, never by run-shell.

Examples:
  tmuxy run swap-pane -s %0 -t %1
  tmuxy run list-panes -F '#{pane_id} #{pane_current_command}'
  tmuxy run copy-mode -q            # leave copy mode
  tmuxy run new-window              # intercepted → safe alternative
```

## `tmuxy cleanup`

```text
Usage: tmuxy cleanup [-n|--dry-run] [-q|--quiet]

Reap shells left hanging in the kernel by a pane that died while its shell was
still starting up. Each one holds a PTY slave open, and enough of them exhaust
the machine's pseudoterminals so that no new pane can be created.

Options:
  -n, --dry-run  List what would be reaped and exit
  -q, --quiet    Print nothing
```

## `tmuxy connect`

```text
Usage: tmuxy connect [socket] [session]

With no arguments, runs `tmuxy session connect`: it asks which machine to
connect to — this one, or [user@]host over SSH — checks it can reach tmux
there, saves the server to the desktop app's server list
(servers.json in tmuxy's state dir; `tmuxy config paths` shows where) and
attaches to it.

With a socket, reconnects the tmuxy DESKTOP APP to a different tmux server
without relaunching. `socket` is a socket name (in tmux's default dir, e.g.
`default` for your everyday tmux server) or a full socket path (containing a
slash). If `session` is omitted, the app attaches to the target server's first
existing session, or creates `tmuxy` if it has none.

This sets a request the running desktop app picks up. It has no effect in the
web UI (the web server's socket is fixed at launch).

Examples:
  tmuxy connect                      # ask for a server, then attach to it
  tmuxy connect default              # attach to your everyday tmux server
  tmuxy connect default work         # ...to its "work" session specifically
  tmuxy connect /tmp/tmux-1000/foo   # attach to a socket by full path
```

## `tmuxy server`

Production server operations

Its subcommands and flags are in [CLI-SERVER.md](CLI-SERVER.md).

## `tmuxy trace`

```text
Inspect a local action-trace file: print a summary, or export a Chrome-trace/Perfetto timeline with `--export` (docs/TRACING.md)

Usage: tmuxy-server trace [OPTIONS] [FILE]

Arguments:
  [FILE]  Trace file to read. Defaults to the standard state-dir `trace.ndjson`

Options:
      --export <PATH>  Export a Chrome-trace/Perfetto JSON timeline to this path instead of printing a summary. Open the result at ui.perfetto.dev
      --mark <LABEL>   Append a marker line with this label to the trace, then exit. Use it to stamp "the bug happened here" so you can find the moment in a long trace
      --health         Run a field health check summarizing reconnects, rejected commands, and anomalies
      --github         With the health check: print each finding as a GitHub Actions annotation (`::warning …`) instead of the report, for a CI step to run on every job, passing or not
      --window <MARK>  Read only the events between the marker with this label and the next marker after it — one test's slice of a whole run's trace
      --last <N>       Read only the last N actions (an `action_id` each, one per thing the user did): every event traced from the first of them to the last, the uncorrelated ones in between included. With no `--health` or `--export`, print those lines as NDJSON, a short slice to paste into a bug report
      --redact         Redact what is printed or exported for sharing: session names, paths, error text, command arguments and marker labels become placeholders (`session-1`, `path-2`), ids, operations and timing stay. Use it on a slice before attaching it to a bug report
      --json           Answer in JSON: `{"ok":true,"output":…}`
  -h, --help           Print help
```

## `tmuxy config`

Re-apply tmuxy.conf (reload), check it (doctor) or change a setting

Its subcommands and flags are in [CLI-CONFIG.md](CLI-CONFIG.md).

## `tmuxy keymap`

```text
Every key binding, and the file and line it comes from. Backs `tmuxy keymap`

Usage: tmuxy-server keymap [OPTIONS] [KEY]

Arguments:
  [KEY]  Only this key, as tmux names it (`t`, `C-a`, `M-Left`)

Options:
      --table <TABLE>  Only this key table (`prefix`, `root`, `pane`, `tab`, …)
      --json           Answer in JSON
  -h, --help           Print help
```

## `tmuxy plugin`

Install, list, update and remove plugins; run their actions

Its subcommands and flags are in [CLI-PLUGIN.md](CLI-PLUGIN.md).

## `tmuxy gui`

```text
Usage: tmuxy gui

Open the desktop GUI application on this socket's session.
```
