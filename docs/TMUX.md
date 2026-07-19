# tmux Integration

This document covers how tmuxy interacts with tmux: control mode architecture, command routing rules, version-specific bugs, and operational constraints.

## tmux Version

Tmuxy targets **tmux 3.7a** (devcontainer, CI, and the in-browser v86 guest all build it from source). Several workarounds below were discovered on 3.3a/3.5a and are kept because they remain safe on 3.7a.

## Dedicated Server Socket

Tmuxy never talks to the user's default tmux server. Every component targets a **dedicated socket**, resolved the same way everywhere:

| Priority | Source                      | Used by                                                                                                                 |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1        | `TMUX_SOCKET` env var       | all components (dev uses `tmuxy-dev`, agents use `tmuxy-prod`)                                                          |
| 2        | Socket derived from `$TMUX` | shell scripts running inside a pane (`bin/tmuxy-cli`, `bin/tmuxy/_lib`) — so they always target the server hosting them |
| 3        | `tmuxy` (the default)       | everything else                                                                                                         |

A `TMUX_SOCKET` value containing a slash is treated as a **full socket path** (`tmux -S <path>`); any other value is a **socket name** in tmux's default socket directory (`tmux -L <name>`). The Rust side resolves via `tmux_socket()` / `tmux_socket_args()` in `tmuxy-core/src/session.rs` and always passes the socket flag explicitly, which also overrides an inherited `$TMUX` — the server behaves identically whether launched from a terminal, a tmux pane, or Finder. Every bundled shell script sources the same resolution from `bin/tmuxy/_lib` (or defines it inline in `bin/tmuxy-cli`); none may call bare `tmux`. The event-queue scripts (`tmuxy event …`) namespace their FIFO directories by the same socket name.

### Live socket switch (desktop app)

The **web server** binds its socket once at process launch (from the env), so it cannot change sockets without a restart. The **desktop (Tauri) app** can switch servers live: `tmuxy connect <socket> [session]` publishes the request as two tmux global env vars (`TMUXY_CONNECT_TO`, `TMUXY_CONNECT_SESSION`) on the current server; a watcher task in the app (`packages/tmuxy-tauri-app/src/monitor.rs`, `poll_connect_requests`) reads them, sets `TMUX_SOCKET`/`TMUXY_SESSION` in-process, and drives the monitor loop to reconnect (a graceful `MonitorCommand::Shutdown` interrupts the live connection). Because every tmux call — the control-mode connection and the one-off executor commands alike — resolves its socket from the env, updating those two vars retargets the whole app. Adopting an existing server applies tmuxy's config and window-type tagging to it, so this is an explicit opt-in, distinct from the isolated default.

### Remote servers over SSH (desktop app)

A "server" in the desktop app is a tmux server tmuxy drives — the local machine or a **remote host reached over SSH**. Saved servers live in `~/.config/tmuxy/servers.json` (`tmuxy-core/src/servers.rs`); the sidebar footer's **server picker** lists them, and the `tmuxy connect` form (a small ratatui TUI in `packages/tmuxy-connect`, opened in a float) adds new ones. Attaching to a server sets `TMUX_SOCKET` and, for a remote, `TMUXY_SSH` (an ssh argv tail like `-p 2222 user@host`); the Tauri `connect_server` command routes both through the same `request_reconnect` path as a local socket switch.

`TMUXY_SSH` is resolved centrally by `ssh_target()` / `tmux_argv(pty)` in `session.rs`: when set, every tmux invocation is wrapped as `ssh [-tt] <tail> tmux -L <socket> …` (the `-tt` pty flag is used for the `-CC` control-mode connection, omitted for one-off reads so captured output stays clean; the remote binary is bare `tmux`, resolved by the remote login shell). The local `-f <config>` flag is skipped over SSH — that path is local-only. This means the whole app (control mode + executor reads) drives the remote tmux server transparently.

### Sessions tree

The live state the app holds is single-session (the attached session's windows/panes). The sidebar's **sessions→tabs→panes tree** is populated by a poll (`serversActor`, `packages/tmuxy-ui/src/machines/actors/serversActor.ts`) that shells `list-windows -a` / `list-panes -a` through `run_tmux_command` every ~1.5s. It runs on both the web and desktop builds — a client attached to a multi-session socket sees and can switch to (`SWITCH_SESSION`) every session; on web `switchSession` reconnects the SSE stream to the chosen session. The active session's subtree is drawn from live state; other sessions come from the poll. The tree only shows the session level when more than one session exists (a lone session stays a flat tab→pane tree). The poll is gated on the adapter's `enumeratesSessions` capability, so it stays inert on the single-session in-browser sandboxes (demo, v86). The **server picker** (saved-server list via `list_servers`) remains desktop-only.

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

| Command              | Short Form                               |
| -------------------- | ---------------------------------------- |
| `split-window`       | `splitw`                                 |
| `new-window`         | `neww` (but see crash workaround below)  |
| `select-pane`        | `selectp`                                |
| `select-window`      | `selectw`                                |
| `kill-pane`          | `killp`                                  |
| `kill-window`        | `killw`                                  |
| `resize-pane`        | `resizep`                                |
| `resize-window`      | `resizew` (ignored if sent externally)   |
| `swap-pane`          | —                                        |
| `break-pane`         | `breakp`                                 |
| `send-keys` / `send` | (for key input, not SGR mouse sequences) |
| `copy-mode`          | —                                        |
| `next-window`        | `next`                                   |
| `previous-window`    | `prev`                                   |
| `next-layout`        | `nextl`                                  |
| `run-shell`          | —                                        |
| `set-environment`    | —                                        |
| `rename-window`      | —                                        |

Use short command forms when sending through control mode.

**Note:** `new` is short for `new-session`, NOT `new-window`. Use `neww` for creating windows.

### Commands Safe to Run as External Subprocesses

These are used in `tmuxy-core/src/executor.rs` and `session.rs`:

| Command           | Location                      | Justification                                                |
| ----------------- | ----------------------------- | ------------------------------------------------------------ |
| `has-session`     | `session.rs`, `connection.rs` | Check if session exists **before** connecting control mode   |
| `new-session`     | `session.rs`                  | Create session **before** control mode attaches              |
| `source-file`     | `session.rs`, `monitor.rs`    | Source config during session creation and initial state sync |
| `kill-session`    | `session.rs`                  | Destroy session (no control mode attached)                   |
| `capture-pane`    | `executor.rs`                 | Initial state capture and scrollback history                 |
| `display-message` | `executor.rs`                 | Query pane metadata (width, history size)                    |
| `list-keys`       | `executor.rs`                 | Read keybindings from tmux config                            |
| `show-options`    | `executor.rs`                 | Read tmux options                                            |
| `list-windows`    | `executor.rs`, `sse.rs`       | `resize_window` fallback; sessions-tree enumeration (`-a`)   |
| `send-keys -l`    | `executor.rs`                 | Mouse event SGR sequences (escape-heavy)                     |
| `list-panes`      | `executor.rs`, `sse.rs`       | Pane info; sessions-tree enumeration (`-a`)                  |
| `list-sessions`   | `sse.rs`                      | Sessions-tree enumeration                                    |
| `load-buffer -`   | `bin/tmuxy-cli` (`pane paste`)| Reads the payload from stdin, which `run-shell` cannot supply. Mutates only the paste buffer, never session/window/pane state, so it does not touch what control mode is tracking. The `paste-buffer` that follows does route through `run-shell`. |

These are safe because they either run **before** control mode connects, are **read-only queries**, or use `send-keys -l` for binary escape sequences that control mode handles differently.

The web server's `RunTmuxCommand` handler (`sse.rs`) normally forwards commands to the control-mode channel fire-and-forget (no stdout back). The three `list-*` reads above are the exception: it runs them as one-off subprocesses via `executor::run_tmux_command_for_session` and returns their stdout, so the frontend's sessions poll can read output on web the same way it does under Tauri. A guard (`is_readonly_query`) rejects compound (`;`) or multiline strings so a mutation can't ride along a read.

### Shell Scripts and `run-shell`

Shell scripts in `bin/tmuxy/` are executed via tmux's `run-shell` command (sent through control mode). Since `run-shell` executes within the tmux server process itself (not as an external subprocess), scripts can safely call tmux CLI commands internally — except `new-window` (see below).

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:**

- `packages/tmuxy-server/src/sse.rs` — The `new_window` command handler, `execute_prefix_binding` for `c` key, and `run_tmux_command` all intercept `neww`/`new-window` and rewrite to `splitw ; breakp`.
- `bin/tmuxy/` shell scripts — Use `split-window -dP` + `break-pane -d -s $PANE -n name` when creating windows from `run-shell`.
- `tests/helpers/TmuxTestSession.js` — Test session creation uses the same workaround.

## Tauri Desktop App: `new-window` Handling

The Tauri `run_tmux_command` handler (`packages/tmuxy-tauri-app/src/commands.rs`) intercepts `new-window`/`neww` and pushes the `splitw ; breakp` rewrite through the control-mode connection, exactly like the web server. The external `executor::new_window()` path survives only as a pre-connection fallback: it runs before any control-mode client is attached (during early startup, before the monitor connects), where the 3.5a crash — which requires an attached control-mode client — cannot occur. If that fallback ever crashes tmux, the reconnect loop recovers.

The native desktop menu (`packages/tmuxy-tauri-app/src/gui.rs`) does **not** run tmux commands itself. It dispatches every tmux-affecting menu item to the frontend via `window.tmuxyMenuAction`, which routes through the same control-mode-safe adapter path as the in-app menu (including the `new-window` rewrite and the `@tmuxy-window-type` tag).

## Targeting: Use Stable IDs, Not Indices

Always target tmux objects by their **stable identifiers**, not by indices:

| Object  | Stable ID | Unstable Index | Example             |
| ------- | --------- | -------------- | ------------------- |
| Session | name      | —              | `-t mysession`      |
| Window  | `@N`      | `:N`           | `-t @3` not `-t :3` |
| Pane    | `%N`      | `.N`           | `-t %5` not `-t .2` |

Window indices (`:0`, `:1`, `:3`) can shift when windows are created or destroyed. Pane indices (`.0`, `.1`) are relative to the current window and change when panes are added/removed. Session names, window IDs (`@N`), and pane IDs (`%N`) are assigned by tmux at creation and never change.

This matters especially in automation and tests where multiple operations happen in sequence — between a query and the next command, indices may have shifted.

## `%unlinked-window-close` Events

**Behavior:** tmux fires `%unlinked-window-close` (instead of `%window-close`) for windows from **other sessions** sharing the same tmux server. The parser handles both event types (`parser.rs`), but `state.rs` intentionally **ignores** `UnlinkedWindowClose` events to avoid polluting the current session's state with events from other sessions.

`%window-close` handles window removal for the current session. `%unlinked-window-close` is only relevant in multi-session environments and is correctly ignored.

## tmux Configuration

For multi-client viewport sizing to work correctly, tmux needs:

```bash
# ~/.tmux.conf or .devcontainer/.tmuxy.conf
setw -g aggressive-resize off   # Don't auto-resize to largest client
set -g window-size manual       # Manual control over window size
```

For OSC 8 hyperlink support:

```bash
set -g terminal-features "hyperlinks"
```

## Flow Control

tmux 3.2+ supports `pause-after` flow control. The monitor configures `pause-after=5` (pause if a client falls 5 seconds behind). When a pane is paused, the monitor responds with `refresh-client -A '%pane:continue'` to resume. This prevents unbounded memory growth during heavy output.

## tmux 3.7a Format Expansion (Critical)

tmux 3.7a expands format strings (`#{...}`) in **more places** than earlier versions. Two of these bit tmuxy in practice; both will affect any code path that upgrades past 3.6b.

### `run-shell` expands its command string

`run-shell "..."` format-expands the whole string before handing it to the shell. A nested `-F '#{pane_id}'` inside a run-shell'd tmux command is therefore pre-expanded against the **currently active pane** — not the pane the inner command creates. This made `float-create` break the _wrong_ pane into the float window.

Rule: inside any `run-shell` string, write `##{...}` — run-shell's expansion halves it to `#{...}` for the inner command. See `bin/tmuxy/float-create` for the canonical example. (3.6b behaves the same; the bug had simply never been triggered through this path before.)

### `send-keys` expands its arguments — and `##` does NOT protect valid variables

On 3.7a, `send-keys -l 'text'` format-expands the literal. Empirically:

| Payload sent   | Pane receives                               |
| -------------- | ------------------------------------------- |
| `#{pane_id}`   | `%0` (expanded)                             |
| `##{pane_id}`  | `#%0` (still expanded!)                     |
| `#{not_a_var}` | `#{not_a_var}` (unknown names pass through) |
| `#(date)`      | `#(date)` (command formats not run)         |

Because doubling the hash does **not** protect a valid variable, the only reliable transport-level fix is to **split the literal into separate `send-keys -l` chunks at every `#`/`{` boundary** so the two characters never share a format context. The v86 client does this in `toControlModeCommand` (`tmuxy-ui/src/tmux/v86/V86TmuxAdapter.ts`); the native server will need the same treatment when it upgrades. On 3.6b, `send-keys -l` does not expand at all.

### Mouse-tracking panes eat pasted SGR sequences — inject with `send-keys -H`

On 3.7a, when a pane's application has enabled mouse reporting (`?1000h`/`?1006h`, i.e. `mouse_any_flag` is set), an SGR mouse sequence (`ESC [< b;x;y M`) delivered to that pane via `paste-buffer` is **consumed by tmux and never reaches the application** — silently, with no error. The same bytes reach a pane that has NOT enabled mouse tracking. This broke tmuxy's synthetic mouse forwarding (browser click → SGR injection), which previously piped through `load-buffer`/`paste-buffer`.

The reliable transport is `send-keys -t <pane> -H <hex bytes>`: raw hex key bytes bypass both the paste path and 3.7a's `send-keys -l` format expansion. The frontend builds these in `tmuxy-ui/src/hooks/scrollUtils.ts` (`sgrMouseCommand`).

One trap: `-H` commands must never be merged by the frontend's send-keys batcher — joining two puts a literal `-H` token mid-keys, tmux rejects it as an unknown key, and the whole combined command fails (a click's press+release land in one batch window, so a plain click would deliver nothing).

### Control-mode stdin wants bare `;` separators

The frontend joins compound commands with a shell-escaped `\;` (correct for commands that pass through a shell or `run-shell` context). But tmux's control-mode line parser treats `\;` as a literal argument, silently erroring the whole command — which orphans the frontend's optimistic state (the "frozen UI after keyboard split" bug). Raw control-mode transports must rewrite the separator to a bare `;` — never inside a `send-keys -l` literal.

## Client-Side Placeholder Substitution

Independent of tmux's own expansion, the frontend substitutes `#{pane_id}`, `#{pane_width}`, and `#{pane_height}` in **every outgoing command** with the active pane's values (`appMachine`'s SEND_TMUX_COMMAND handler). This is deliberate — prefix-binding commands are written against these placeholders — but it means text typed or pasted into a terminal containing those three exact placeholders is substituted before tmux ever sees it, on every transport (server, Tauri, v86).

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.

## JSON in tmux Environment Variables

tmux doesn't handle newlines in environment variables. Always use `jq -c` (compact, single-line output) when storing JSON via `set-environment`.

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — TmuxMonitor, ControlModeConnection, and command channel details
- [DATA-FLOW.md](DATA-FLOW.md) — How commands flow through control mode in different deployment scenarios
- [SECURITY.md](SECURITY.md) — Security implications of `run-shell` and arbitrary command execution
