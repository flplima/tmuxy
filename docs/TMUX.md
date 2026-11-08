# tmux Integration

This document covers how tmuxy interacts with tmux: control mode architecture, command routing rules, version-specific bugs, and operational constraints.

See [TMUX-VERSION-BUGS.md](TMUX-VERSION-BUGS.md) for these sections: tmux Version; `new-window` Crashes Control Mode; Tauri Desktop App: `new-window` Handling; `%unlinked-window-close` Events; `pane_in_mode` Is Not "In Copy Mode"; Flow Control; tmux 3.7a Format Expansion (Critical); `list-keys` Reports Aliases Already Expanded; Client-Side Placeholder Substitution; Bash Variable Conflicts.

See [TMUX-CONFIG.md](TMUX-CONFIG.md) for these sections: Dedicated Server Socket; Session groups: two GUI windows over one session; tmux Configuration; Key Tables Are the Client's.

## Control Mode Architecture

Tmuxy communicates with tmux through **control mode** (`tmux -CC`), which provides real-time event notifications and command execution through a single stdin/stdout connection. No polling is required.

```
Commands:  Frontend → Backend → MonitorCommand → Monitor → stdin → tmux -CC
Events:    Frontend ← Backend ← StateEmitter ← Monitor ← stdout ← tmux -CC
```

The `TmuxMonitor` (in `tmuxy-core/src/control_mode/monitor.rs`) maintains a persistent `tmux -CC attach-session` subprocess via `ControlModeConnection`. All state-modifying commands flow through the monitor's command channel as `MonitorCommand::RunCommand` messages. The monitor writes commands to control mode stdin, and tmux sends notifications back through stdout (`%output`, `%layout-change`, `%window-add`, etc.).

A connection counts as made only once control mode opens (X7 in [INVARIANTS.md](INVARIANTS.md)). `tmux -CC` writes a DCS (`ESC P 1000 p`) glued to the `%begin` of the block that answers its own `attach-session` or `new-session`: that block closing with `%end`, or a first notification, means attached. An `%error` closing it carries tmux's reason (a session it will not create), `%exit` means the client left, and a plain line before any of it is tmux or ssh talking on its way out; the connect fails with those words and tmux's exit status, and the host's backoff takes over (`tmuxy-core/src/control_mode/connection/spawn.rs`, `host/supervise.rs`).

## Why Control Mode Only

Running external `tmux` commands (as separate subprocesses) while a control mode client is attached can **crash the tmux server**. Observed in tmux 3.3a and 3.5a. The [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

Every client command, on both hosts, goes through `host::command::handle` (`tmuxy-core/src/host/command.rs`), which routes it and writes it to the session's monitor channel (`control_mode::run` / `control_mode::query`, `tmuxy-core/src/control_mode/channel.rs`).

## Command Routing Rules

### Commands That MUST Go Through Control Mode

Any command that **modifies** session state when a control mode client is attached:

| Command | Short Form |
| --- | --- |
| `split-window` | `splitw` |
| `new-window` | `neww` (but see crash workaround below) |
| `select-pane` | `selectp` |
| `select-window` | `selectw` |
| `kill-pane` | `killp` |
| `kill-window` | `killw` |
| `resize-pane` | `resizep` |
| `resize-window` | `resizew` (ignored if sent externally) |
| `swap-pane` | — |
| `break-pane` | `breakp` |
| `send-keys` / `send` | (for key input, not SGR mouse sequences) |
| `copy-mode` | — |
| `next-window` | `next` |
| `previous-window` | `prev` |
| `next-layout` | `nextl` |
| `run-shell` | — |
| `set-environment` | — |
| `rename-window` | — |

Use short command forms when sending through control mode.

**Note:** `new` is short for `new-session`, NOT `new-window`. Use `neww` for creating windows.

### What still runs outside control mode, and why

Every command a client sends — mutations through `run_tmux_command`, reads through
`query_tmux` — rides the monitor's control-mode connection. Reads are answered in-band:
the monitor brackets the command with marker lines and hands back the `%begin…%end`
blocks between them (`MonitorCommand::RunCommandWithReply`, `Markers::reply_wrapped_lines`
in `tmuxy-core/src/control_mode/state/markers.rs`). Each marker carries a token
drawn at random when the connection's aggregator is made: a capture or a query prints
whatever a pane shows, so a fixed marker word could be printed by any program, and one
that closed a capture early once left every new client waiting for a first state that
never came. A `display-message -p` prints to the control client alone, so no pane's
output carries the token (tmux's message log keeps it, but only a program with the tmux
socket can read that, and such a program can run any command anyway). It is hex, which
neither tmux's parser nor `display-message`'s format and time expansion reads anything
into. For the same reason the parser closes a block
only on the `%end`/`%error` that repeats its `%begin`'s time, number and flags (A13 in
[INVARIANTS.md](INVARIANTS.md)). Mutations other than keystrokes are bracketed
too, so an `%error` can be attributed to the command that caused it and reported to the
user instead of being lost in the stream. Nothing a client sends reaches a shell, and no
per-command `tmux` process is spawned on either transport. The policy for what goes
where lives once, in `tmuxy-core/src/command_router.rs`, and both transports call it. It
reads a client's command the way control mode will: line by line (control mode runs one
command per line, and an empty line detaches the client, so a blank one is dropped), and
each line split wherever tmux would split it — a bare `;` as well as `\;`, quotes and
backslash escapes read as tmux reads them — with a command recognised by its name, its
alias, and any prefix of its name no other command shares (`resize-w` is
`resize-window`). A query (`query_tmux`) runs only tmux's reads; anything else goes
through `run_tmux_command`.

Both transports hand a client's command to the same function, `tmuxy_core::host::handle`
(`tmuxy-server/src/sse/commands.rs`, `tmuxy-tauri-app/src/commands.rs`), and the config chain,
`show-options` and `list-keys` ride the connection too (`tmuxy-core/src/host/bindings.rs`). The
tmux subprocesses that remain run where no control-mode client of the session exists yet, or
beside one as a read tmux allows (every site goes through `tmux_command()` / `tmux_output` in
`tmuxy-core/src/session.rs`):

| Command | Where | Why |
| --- | --- | --- |
| `has-session`, `list-sessions` | `session.rs`, `control_mode/connection/spawn.rs`, the desktop's attach dialog (`tmuxy-tauri-app/src/windows/attach.rs`) | Read-only: which sessions exist, before connecting |
| `tmux -CC new-session -A` | `control_mode/connection/spawn.rs` | The control-mode connection itself, which creates the session when it is missing. A further session is created over an existing connection (`create_session_via` in `tmuxy-core/src/host.rs` sends `new-session -d`) |
| `load-buffer -` | the `send` verb's `--paste` (`tmuxy-verbs/src/send_cli.rs`, behind `pane paste`) | Reads its payload from stdin, which `run-shell` cannot supply; touches only the paste buffer. The `paste-buffer` that follows goes through `run-shell` |
| `capture-pane -p` | `host/socket_watch/agent_screen.rs` | A read-only look at the bottom of an agent's pane for an approval dialog; its one write is a `run-shell -b` |

`session::tmux_output` also runs the CLI's own verbs (`tmuxy-verbs`), which tmux executes inside
`run-shell`; `kill-session` is one of them (`session forget --force`,
`tmuxy-verbs/src/session_cli.rs`), and the desktop's session-group windows send theirs over the
base session's monitor (`tmuxy-tauri-app/src/windows.rs`). Do not add to this table: a read a
client needs goes through `query_tmux`, and a read the core needs while attached goes through the
aggregator's in-band path.

### Shell Scripts and `run-shell`

Shell scripts in `packages/tmuxy-cli/bin/tmuxy/` are executed via tmux's `run-shell` command (sent through control mode). Since `run-shell` executes within the tmux server process itself (not as an external subprocess), scripts can safely call tmux CLI commands internally — except `new-window` (see below).

A `run-shell` the CLI sends from a pane carries that pane as its `-t` target, and the pane rides along as the inner command's `TMUX_PANE`: the shell half's `_run_as_caller` in `packages/tmuxy-cli/bin/tmuxy/_lib`, the verbs' `run_shell::tmux_as` (`tmuxy-core/src/run_shell.rs`). Every pane- or window-scoped command the CLI builds also names the caller's pane explicitly. All of it is needed: the CLI's own `tmux` client is unattached, and for an unattached client tmux resolves a target-less command — and the formats `run-shell` expands, such as `#{pane_id}` — to the session's current window and active pane, not to the pane in `TMUX_PANE`. Without them a `pane split` or `pane group add` typed in a background tab acted on the tab in front.

## Targeting: Use Stable IDs, Not Indices

Always target tmux objects by their **stable identifiers**, not by indices:

| Object | Stable ID | Unstable Index | Example |
| --- | --- | --- | --- |
| Session | name | — | `-t mysession` |
| Window | `@N` | `:N` | `-t @3` not `-t :3` |
| Pane | `%N` | `.N` | `-t %5` not `-t .2` |

Window indices (`:0`, `:1`, `:3`) can shift when windows are created or destroyed. Pane indices (`.0`, `.1`) are relative to the current window and change when panes are added/removed. Session names, window IDs (`@N`), and pane IDs (`%N`) are assigned by tmux at creation and never change.

This matters especially in automation and tests where multiple operations happen in sequence — between a query and the next command, indices may have shifted.

The same rule shapes the tab strip. Chrome windows (floats, sidebars) hold tmux indices the user never sees, so `select-window -t N` from a root binding lands on the wrong tab whenever one sits before it. tmuxy resolves `ctrl+1`…`ctrl+9` on the client, by **position in the strip** (the index-ordered visible tabs), and ships no `bind -n C-N` lines in its config.

Every window or pane the client names in a command is an **id** (`@N` / `%N`), never a tmux index: `renumber-windows` shifts indices whenever a window closes and tmux announces none of the shifts, so an index the client holds can be a beat stale. The backend re-lists windows after any window add, close or reorder, but the id rule is what makes a stale list harmless.

A command must also name the **window** it acts on, not just the pane: `select-pane` on a pane in another window sets that window's active pane and leaves tmux's current window alone, so a `split-window` after it still runs wherever tmux already was. The keyboard actor's pin therefore leads with `select-window` (taking the window from the pinned pane when the machine has not published an active one yet), and the sidebar and float creators name the pane they split, because nothing in their command list switches windows first. No target is ever added on the way to tmux, on either transport: the pinned list reaches the control-mode connection byte-identical (`command_router::route_command`). A session target would be resolved late, against the session's _current_ window, so a concurrent `select-window` between the pin and the split could move the split to another tab; the untargeted command after a pin, sent as-is, inherits the queue's current target and holds it.

`ctrl+0` (and `prefix w`, and the grid button at the right end of the app header) opens the Tab Overview — a client-side grid of every tab where a slot click selects, the trailing "+" creates, a slot's ✕ kills, and a drag reorders by sending `move-window -b`/`-a` against the neighbouring tab's `@id` (a tab dragged along the strip itself reorders the same way). Each slot draws its tab's panes with the screen each pane had when the overview opened: a still taken once by the `useTabStill` hook (`tmuxy-ui/src/components/useTabStill.ts`), so a tab that keeps printing does not churn its thumbnail. See `tmuxy-ui/src/machines/app/actions/tabOverview.ts` and `tmuxy-ui/src/components/TabOverview.tsx`.

## Pane Titles

A pane header shows what the running application called itself, falling back to its process name. The two sources disagree often enough that the order matters:

| Source | tmux format | Notes |
| --- | --- | --- |
| App title | `pane_title` | Set by the application over OSC 0/2 — `nvim README.md`, an ssh host, a Claude Code session summary. |
| Process name | `pane_current_command` | Only the executable's **file name**. A version-pinned launcher symlink (`~/.local/bin/claude` → `…/versions/2.1.251`) reports the version number, which is useless as a label. |

The catch is that tmux **seeds every pane's `pane_title` with the host name**, so a non-empty value does not by itself mean an application set one. Rather than shipping the host name to every client to compare there, the pane enumerations ask tmux to do the comparison and return an empty field when the title is still the seed — `tmux_formats::APP_PANE_TITLE` in `tmuxy-core/src/constants/tmux_formats.rs`. The CLI's copy (`APP_PANE_TITLE_FMT` in `packages/tmuxy-cli/bin/tmuxy/_options`) and the UI's (`tmuxy-ui/src/domain/tmuxyConstants.gen.ts`, read by the sessions-tree poll in `tmuxy-ui/src/machines/actors/serversActor.ts`) are **generated** from it by `tmuxy-core/tests/generated_constants.rs`, which fails when either file is stale and rewrites both under `UPDATE_GENERATED=1`. The sessions poll reads its rows through `query_tmux`, answered in-band on the control-mode connection like every other read.

Downstream, an empty title unambiguously means "no app title", so every consumer resolves `title → command → 'shell'` (`getTabText` in `tmuxy-ui/src/components/paneTabDisplay.ts`). One consequence is inherent to the rule: tmux keeps the last title a pane was given, so a title can outlive the program that set it until the shell's own prompt hook replaces it.

Titles change without any control-mode event, so they ride the regular `list-panes` refresh and the pane delta must carry the `title` field for a change to reach a connected client.

### Pane rows

Every list the monitor polls — `list-panes`, `list-windows` and the stash session's panes — is built from one column table (`PaneColumn`, `WindowColumn`, `StashColumn` in `tmuxy-core/src/constants/tmux_formats.rs`): each column's name is the index the parser (`Row`) reads its field at, the command string is assembled from the same list, and the test fixtures write their rows with the same table (`RowBuilder`), so none of them can drift. Every `@tmuxy-*` column is spelled by its `tmux_options` constant. Every free-text column — the app title, the border title, the process name, the restore line, the window name — is comma-escaped by tmux itself (`s/,/%2C/`), so a row always has exactly one field per column and a comma in a title cannot shift the fields after it; the parser drops a row with any other field count, or without a pane size, rather than guess. Only `-F` list output is read this way: `display-message -p` strips the `%` from the escape.

Each of those lists goes out marker-bracketed like a capture (`Markers::list_command`), and its rows are read only as the answer the marker names. A block with no marker before it — the ack of a keystroke, of a setup command, a client's query — is never sniffed for rows and changes nothing.

See [TMUX-TAGS.md](TMUX-TAGS.md) for this section: Window Tags (`@tmuxy-*`).

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — TmuxMonitor, ControlModeConnection, and command channel details
- [DATA-FLOW.md](DATA-FLOW.md) — How commands flow through control mode in different deployment scenarios
- [SECURITY.md](SECURITY.md) — Security implications of `run-shell` and arbitrary command execution
