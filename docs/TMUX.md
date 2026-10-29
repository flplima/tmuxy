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

## Why Control Mode Only

Running external `tmux` commands (as separate subprocesses) while a control mode client is attached can **crash the tmux server**. Observed in tmux 3.3a and 3.5a. The [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

All HTTP command handlers in the web server route through `send_via_control_mode()` in `tmuxy-server/src/sse.rs`, which looks up the session's `monitor_command_tx` and sends `MonitorCommand::RunCommand` through the channel.

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
blocks between them (`MonitorCommand::RunCommandWithReply`, `reply_wrapped_lines` in
`tmuxy-core/src/control_mode/state.rs`). Mutations other than keystrokes are bracketed
too, so an `%error` can be attributed to the command that caused it and reported to the
user instead of being lost in the stream. Nothing a client sends reaches a shell, and no
per-command `tmux` process is spawned on either transport. The policy for what goes
where lives once, in `tmuxy-core/src/command_router.rs`, and both transports call it.

The subprocess calls that remain are in `tmuxy-core/src/session.rs` and
`control_mode/connection.rs`, and each is needed before any control-mode client exists
(`session::tmux_output` also serves the CLI's own verbs, which tmux runs inside
`run-shell`). The paste-buffer mirror is not among them: a copy-mode yank is read back
in-band, by the aggregator, on both hosts.

| Command | Location | Justification |
| --- | --- | --- |
| `has-session` | `session.rs`, `connection.rs` | Check if session exists **before** connecting control mode |
| `new-session` | `session.rs` | Create session **before** control mode attaches |
| `source-file` | `session.rs`, `monitor.rs` | Source config during session creation and initial state sync |
| `kill-session` | `session.rs` | Destroy session (no control mode attached) |
| `show-options` | `gui.rs` (desktop setup) | The window's blur/appearance is read before the monitor starts |
| `load-buffer -` | `packages/tmuxy-cli/bin/tmuxy/send` (`pane paste`, through `send --paste`) | Reads the payload from stdin, which `run-shell` cannot supply. Mutates only the paste buffer, never session/window/pane state, so it does not touch what control mode is tracking. The `paste-buffer` that follows does route through `run-shell`. |

These are safe because they run **before** control mode connects. Do not add to this
table: a read a client needs goes through `query_tmux`, and a read the core needs while
attached goes through the aggregator's in-band path.

### Shell Scripts and `run-shell`

Shell scripts in `packages/tmuxy-cli/bin/tmuxy/` are executed via tmux's `run-shell` command (sent through control mode). Since `run-shell` executes within the tmux server process itself (not as an external subprocess), scripts can safely call tmux CLI commands internally — except `new-window` (see below).

A `run-shell` the CLI sends from a pane carries that pane as its `-t` target (`_run_shell` in `packages/tmuxy-cli/bin/tmuxy/_lib`), and every pane- or window-scoped command the CLI builds names the caller's pane explicitly. Both are needed: the CLI's own `tmux` client is unattached, and for an unattached client tmux resolves a target-less command — and the formats `run-shell` expands, such as `#{pane_id}` — to the session's current window and active pane, not to the pane in `TMUX_PANE`. Without them a `pane split` or `pane group add` typed in a background tab acted on the tab in front.

## Targeting: Use Stable IDs, Not Indices

Always target tmux objects by their **stable identifiers**, not by indices:

| Object | Stable ID | Unstable Index | Example |
| --- | --- | --- | --- |
| Session | name | — | `-t mysession` |
| Window | `@N` | `:N` | `-t @3` not `-t :3` |
| Pane | `%N` | `.N` | `-t %5` not `-t .2` |

Window indices (`:0`, `:1`, `:3`) can shift when windows are created or destroyed. Pane indices (`.0`, `.1`) are relative to the current window and change when panes are added/removed. Session names, window IDs (`@N`), and pane IDs (`%N`) are assigned by tmux at creation and never change.

This matters especially in automation and tests where multiple operations happen in sequence — between a query and the next command, indices may have shifted.

The same rule shapes the tab strip. Chrome windows (floats, sidebars) hold tmux indices the user never sees, so `select-window -t N` from a root binding lands on the wrong tab whenever one sits before it. tmuxy therefore resolves `ctrl+1`…`ctrl+9` on the client, by **position in the strip** (the index-ordered visible tabs), and no longer ships `bind -n C-N` lines in its config. Every window or pane the client then names in a command is an **id** (`@N` / `%N`), never a tmux index: `renumber-windows` shifts indices whenever a window closes and tmux announces none of the shifts, so an index the client holds can be a beat stale (a split once landed in the wrong tab that way). The backend re-lists windows after any window add, close or reorder, but the id rule is what makes a stale list harmless. A command must also name the WINDOW it acts on, not just the pane: `select-pane` on a pane in another window sets that window's active pane and leaves tmux's current window alone, so a `split-window` after it still runs wherever tmux already was. The keyboard actor's pin therefore always leads with `select-window` (taking the window from the pinned pane when the machine has not published an active one yet), and the sidebar and float creators name the pane they split, because nothing in their command list switches windows first. No target is ever added on the way to tmux, on either transport: the pinned list reaches the control-mode connection byte-identical (`command_router::route_command`). A session target would be resolved late, against the session's _current_ window, so a concurrent `select-window` between the pin and the split could move the split to another tab; the untargeted command after a pin, sent as-is, inherits the queue's current target and holds it. `ctrl+0` (and `prefix w`, and the grid button at the right end of the app header) opens the Tab Overview — a client-side grid of every tab where a slot click selects, the trailing "+" creates, a slot's ✕ kills, and a drag reorders by sending `move-window -b`/`-a` against the neighbouring tab's `@id` (a tab dragged along the strip itself reorders the same way). Each slot draws its tab's panes with the screen each pane had when the overview opened: a still taken once by the `useTabStill` hook (`tmuxy-ui/src/hooks/useTabStill.ts`), so a tab that keeps printing does not churn its thumbnail. See `tmuxy-ui/src/machines/app/actions/tabOverview.ts` and `tmuxy-ui/src/components/TabOverview.tsx`.

## Pane Titles

A pane header shows what the running application called itself, falling back to its process name. The two sources disagree often enough that the order matters:

| Source | tmux format | Notes |
| --- | --- | --- |
| App title | `pane_title` | Set by the application over OSC 0/2 — `nvim README.md`, an ssh host, a Claude Code session summary. |
| Process name | `pane_current_command` | Only the executable's **file name**. A version-pinned launcher symlink (`~/.local/bin/claude` → `…/versions/2.1.251`) reports the version number, which is useless as a label. |

The catch is that tmux **seeds every pane's `pane_title` with the host name**, so a non-empty value does not by itself mean an application set one. Rather than shipping the host name to every client to compare there, the pane enumerations ask tmux to do the comparison and return an empty field when the title is still the seed — `tmux_formats::APP_PANE_TITLE` in `tmuxy-core/src/constants.rs`, mirrored by the `list-panes` formats in `packages/tmuxy-cli/bin/tmuxy-cli` and the sessions-tree poll in `tmuxy-ui/src/machines/actors/serversActor.ts`. All four must stay in step; the `constants.rs` tests guard the Rust pair. The sessions poll reads its rows through `query_tmux`, answered in-band on the control-mode connection like every other read.

Downstream, an empty title unambiguously means "no app title", so every consumer resolves `title → command → 'shell'` (`getTabText` in `tmuxy-ui/src/components/paneTabDisplay.ts`). One consequence is inherent to the rule: tmux keeps the last title a pane was given, so a title can outlive the program that set it until the shell's own prompt hook replaces it.

Titles change without any control-mode event, so they ride the regular `list-panes` refresh and the pane delta must carry the `title` field for a change to reach a connected client.

### Pane rows

The `list-panes` format the monitor polls with is built from one column table (`PaneColumn` in `tmuxy-core/src/constants/tmux_formats.rs`): each column's name is the index the parser reads its field at, and the command string is assembled from the same list, so the two cannot drift. Every free-text column — the app title, the border title, the process name, the restore line — is comma-escaped by tmux itself (`s/,/%2C/`), so a row always has exactly one field per column and a comma in a title cannot shift the fields after it; the parser drops a row with any other field count rather than guess. Only `list-panes -F` output is read this way: `display-message -p` strips the `%` from the escape.

See [TMUX-TAGS.md](TMUX-TAGS.md) for this section: Window Tags (`@tmuxy-*`).

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — TmuxMonitor, ControlModeConnection, and command channel details
- [DATA-FLOW.md](DATA-FLOW.md) — How commands flow through control mode in different deployment scenarios
- [SECURITY.md](SECURITY.md) — Security implications of `run-shell` and arbitrary command execution
