# tmux Integration

This document covers how tmuxy interacts with tmux: control mode architecture, command routing rules, version-specific bugs, and operational constraints.

## tmux Version

Tmuxy targets **tmux 3.5a**. Some bugs also affect 3.3a.

## Control Mode Architecture

Tmuxy communicates with tmux through **control mode** (`tmux -CC`), which provides real-time event notifications and command execution through a single stdin/stdout connection. No polling is required.

```
Commands:  Frontend → Backend → MonitorCommand → Monitor → stdin → tmux -CC
Events:    Frontend ← Backend ← StateEmitter ← Monitor ← stdout ← tmux -CC
```

The `TmuxMonitor` (in `tmuxy-core/src/control_mode/monitor.rs`) maintains a persistent `tmux -CC attach-session` subprocess via `ControlModeConnection`. All state-modifying commands flow through the monitor's command channel as `MonitorCommand::RunCommand` messages. The monitor writes commands to control mode stdin, and tmux sends notifications back through stdout (`%output`, `%layout-change`, `%window-add`, etc.).

## Why Control Mode Only

Running external `tmux` commands (as separate subprocesses) while a control mode client is attached can **crash the tmux server**. Observed in tmux 3.3a and 3.5a. The [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

All HTTP command handlers in the web server route through `send_via_control_mode()` in `web-server/src/sse.rs`, which looks up the session's `monitor_command_tx` and sends `MonitorCommand::RunCommand` through the channel.

## Command Routing Rules

### Commands That MUST Go Through Control Mode

Any command that **modifies** session state when a control mode client is attached:

| Command | Short Form |
|---------|------------|
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

### Commands Safe to Run as External Subprocesses

These are used in `tmuxy-core/src/executor.rs` and `session.rs`:

| Command | Location | Justification |
|---------|----------|---------------|
| `has-session` | `session.rs`, `connection.rs` | Check if session exists **before** connecting control mode |
| `new-session` | `session.rs` | Create session **before** control mode attaches |
| `source-file` | `session.rs`, `monitor.rs` | Source config during session creation and initial state sync |
| `kill-session` | `session.rs` | Destroy session (no control mode attached) |
| `capture-pane` | `executor.rs` | Initial state capture and scrollback history |
| `display-message` | `executor.rs` | Query pane metadata (width, history size) |
| `list-keys` | `executor.rs` | Read keybindings from tmux config |
| `show-options` | `executor.rs` | Read tmux options |
| `list-windows` | `executor.rs` | Used by `resize_window` fallback |
| `send-keys -l` | `executor.rs` | Mouse event SGR sequences (escape-heavy) |
| `list-panes` | `executor.rs` | Query pane info |

These are safe because they either run **before** control mode connects, are **read-only queries**, or use `send-keys -l` for binary escape sequences that control mode handles differently.

### Shell Scripts and `run-shell`

Shell scripts in `scripts/tmuxy/` are executed via tmux's `run-shell` command (sent through control mode). Since `run-shell` executes within the tmux server process itself (not as an external subprocess), scripts can safely call tmux CLI commands internally — except `new-window` (see below).

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:**
- `packages/web-server/src/sse.rs` — The `new_window` command handler, `execute_prefix_binding` for `c` key, and `run_tmux_command` all intercept `neww`/`new-window` and rewrite to `splitw ; breakp`.
- `scripts/tmuxy/` shell scripts — Use `split-window -dP` + `break-pane -d -s $PANE -n name` when creating windows from `run-shell`.
- `tests/helpers/TmuxTestSession.js` — Test session creation uses the same workaround.

## Tauri Desktop App: Missing `new-window` Workaround

**Known gap:** The Tauri desktop app (`tauri-app/src/commands.rs`) calls `executor::new_window()` which uses external `tmux new-window` without the `splitw ; breakp` workaround. This will crash tmux 3.5a when a control mode client is attached. The web server version (`web-server/src/sse.rs`) has the workaround but the Tauri code path bypasses it.

## `%unlinked-window-close` Events

**Behavior:** tmux fires `%unlinked-window-close` (instead of `%window-close`) for windows from **other sessions** sharing the same tmux server. The parser handles both event types (`parser.rs`), but `state.rs` intentionally **ignores** `UnlinkedWindowClose` events to avoid polluting the current session's state with events from other sessions.

`%window-close` handles window removal for the current session. `%unlinked-window-close` is only relevant in multi-session environments and is correctly ignored.

## tmux Configuration

For multi-client viewport sizing to work correctly, tmux needs:

```bash
# ~/.tmux.conf or docker/.tmuxy.conf
setw -g aggressive-resize off   # Don't auto-resize to largest client
set -g window-size manual       # Manual control over window size
```

For OSC 8 hyperlink support:

```bash
set -g terminal-features "hyperlinks"
```

## Flow Control

tmux 3.2+ supports `pause-after` flow control. The monitor configures `pause-after=5` (pause if a client falls 5 seconds behind). When a pane is paused, the monitor responds with `refresh-client -A '%pane:continue'` to resume. This prevents unbounded memory growth during heavy output.

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.

## JSON in tmux Environment Variables

tmux doesn't handle newlines in environment variables. Always use `jq -c` (compact, single-line output) when storing JSON via `set-environment`.

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — TmuxMonitor, ControlModeConnection, and command channel details
- [DATA-FLOW.md](DATA-FLOW.md) — How commands flow through control mode in different deployment scenarios
- [SECURITY.md](SECURITY.md) — Security implications of `run-shell` and arbitrary command execution
