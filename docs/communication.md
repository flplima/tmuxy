# Communication Architecture

This document describes how the different layers of tmuxy communicate with each other.

## Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Frontend (React + XState)                      │
│                                                                          │
│   ┌─────────────────────────┐   ┌───────────────────────────────────┐   │
│   │      SSE Adapter        │   │        Tauri IPC Adapter          │   │
│   │  (web version only)     │   │    (desktop version only)         │   │
│   └─────────┬───────────────┘   └──────────┬────────────────────────┘   │
└─────────────│───────────────────────────────│────────────────────────────┘
              │                               │
    ┌─────────▼───────────────┐   ┌──────────▼────────────────────────┐
    │   Axum Web Server       │   │       Tauri App Shell             │
    │                         │   │                                    │
    │  GET /events  → SSE     │   │  invoke() → Rust command handler  │
    │  POST /commands → JSON  │   │  events   → Tauri event emitter   │
    └─────────┬───────────────┘   └──────────┬────────────────────────┘
              │                               │
              └───────────┬───────────────────┘
                          │
              ┌───────────▼───────────────────┐
              │     tmuxy-core (Rust lib)      │
              │                                │
              │  TmuxMonitor + StateAggregator │
              └───────────┬───────────────────┘
                          │
              ┌───────────▼───────────────────┐
              │   tmux control mode (stdin)    │
              │                                │
              │   tmux -CC attach -t session   │
              └───────────────────────────────┘
```

## Frontend ↔ Rust Backend

The frontend communicates with the Rust backend through an **adapter pattern**. The `TmuxAdapter` interface abstracts the transport, allowing the same XState machines and React components to work with either backend:

### Web Version: SSE + HTTP POST

The web version uses two HTTP endpoints:

- **`GET /events?session=<name>`** — Server-Sent Events (SSE) stream for server→client communication
  - Connection info (connection ID, session token, default shell)
  - Keybindings (loaded from tmux config)
  - State updates (full snapshots and incremental deltas)
  - Error notifications

- **`POST /commands?session=<name>`** — HTTP POST for client→server commands
  - Authenticated via `X-Session-Token` header (received from SSE connection)
  - Request: `{ "cmd": "command_name", "args": {...} }`
  - Response: `{ "result": ... }` or `{ "error": "message" }`

This replaces the earlier WebSocket-based protocol. SSE was chosen because:
- Simpler than WebSocket (standard HTTP, works through all proxies/CDNs)
- Native browser reconnection (`EventSource` auto-reconnects)
- Server-to-client is the dominant direction (state updates); client-to-server commands are infrequent
- Event IDs enable resumption after brief disconnects (delta sequence numbers)

### Desktop Version: Tauri IPC

The Tauri desktop app uses direct IPC (inter-process communication):

- **`invoke()`** — Client→server commands (equivalent to HTTP POST)
- **Tauri events** — Server→client state updates (equivalent to SSE)

Tauri IPC has lower latency than HTTP since it bypasses the network stack entirely.

### Adapter Interface

Both transports implement the `TmuxAdapter` interface defined in `tmuxy-ui/src/tmux/types.ts`. Key methods:

- `connect()` / `disconnect()` — Lifecycle
- `isConnected()` / `isReconnecting()` — Connection state queries
- `invoke<T>(cmd, args?)` — Send a command to the backend (args is optional)
- `onStateChange(listener)` — Subscribe to state updates
- `onError(listener)` — Subscribe to error notifications
- `onConnectionInfo(listener)` — Receive connection ID and default shell
- `onReconnection(listener)` — Notified on successful reconnection
- `onKeyBindings(listener)` — Receive tmux keybindings

The `tmuxActor` XState actor uses whichever adapter is injected, making the frontend transport-agnostic.

## Rust Backend ↔ tmux

**All runtime communication with the tmux server MUST go through tmux control mode.** The tmux CLI (`tmux` command) must NEVER be used to send commands to a session that has a control mode client attached.

### Why Control Mode Only

When a tmux control mode client (`tmux -CC`) is attached to a session, running external `tmux` commands as separate processes can **crash the tmux server** (observed in tmux 3.3a and 3.5a). See [tmux.md](tmux.md) for version-specific workarounds. The [tmux Control Mode documentation](https://github.com/tmux/tmux/wiki/Control-Mode) states that commands should be sent through the control mode client.

### How It Works

The `TmuxMonitor` maintains a persistent `tmux -CC attach-session` process:

```
Commands:  Frontend → HTTP/IPC → send_via_control_mode() → Monitor → stdin → tmux -CC
Events:    Frontend ← SSE/IPC ← SseEmitter/TauriEmitter ← Monitor ← stdout ← tmux -CC
```

1. **Commands flow in** through `MonitorCommand::RunCommand` via an `mpsc` channel
2. The monitor writes the command to the control mode process's **stdin**
3. tmux processes the command and sends **notifications on stdout** (`%output`, `%layout-change`, etc.)
4. The monitor's `StateAggregator` processes these events into state updates
5. State updates are emitted via the `StateEmitter` trait to the frontend

### MonitorCommand Types

The `MonitorCommand` enum (in `tmuxy-core/src/control_mode/monitor.rs`) has three variants: `ResizeWindow { cols, rows }` for viewport resize, `RunCommand { command }` for arbitrary tmux commands, and `Shutdown` for graceful disconnection.

### Acceptable tmux CLI Usage

The tmux CLI (`std::process::Command::new("tmux")`) is only used for operations that happen **outside** of an active control mode session:

| Operation | Location | Justification |
|-----------|----------|---------------|
| `has-session` | `session.rs`, `connection.rs` | Check if session exists **before** connecting control mode |
| `new-session` | `session.rs` | Create session **before** control mode attaches |
| `source-file` | `session.rs`, `monitor.rs` | Source config during session creation (external) and initial state sync (control mode) |
| `kill-session` | `session.rs` | Destroy session (no control mode attached) |
| `capture-pane` | `executor.rs` | Used for initial state capture and scrollback history |
| `display-message` | `executor.rs` | Query pane metadata (width, history size) |
| `list-keys` | `executor.rs` | Read keybindings from tmux config |
| `show-options` | `executor.rs` | Read tmux options |
| `list-windows` | `executor.rs` | Used by `resize_window` fallback |
| `send-keys -l` | `executor.rs` | Mouse event SGR sequences (escape-heavy) |
| `list-panes` | `executor.rs` | Query pane info |

These are safe because they either:
1. Run **before** control mode connects (session lifecycle)
2. Are **read-only queries** that don't modify session state
3. Use `send-keys -l` for binary escape sequences that control mode handles differently

### Commands That MUST Go Through Control Mode

Any command that **modifies** the session state when a control mode client is attached:

- `split-window` / `splitw`
- `new-window` / `neww` (crashes tmux 3.5a if sent externally)
- `select-pane` / `selectp`
- `select-window` / `selectw`
- `kill-pane` / `killp`
- `kill-window` / `killw`
- `resize-pane` / `resizep`
- `resize-window` / `resizew` (ignored if sent externally)
- `swap-pane`
- `break-pane` / `breakp`
- `send-keys` / `send` (for key input, not SGR mouse sequences)
- `copy-mode`
- `next-window` / `next`
- `previous-window` / `prev`
- `next-layout` / `nextl`
- `run-shell`
- `set-environment`
- `rename-window`

Use short command forms when sending through control mode: `splitw`, `selectp`, `killp`, etc.

### The `send_via_control_mode` Helper

All server-side command handlers route through `send_via_control_mode()` in `web-server/src/sse.rs`. It looks up the session's `monitor_command_tx` and sends `MonitorCommand::RunCommand` through the channel, ensuring the command goes through the control mode stdin connection.

## Shell Scripts (run-shell)

Shell scripts in `/workspace/scripts/tmuxy/` are executed via tmux's `run-shell` command, which is sent through control mode. These scripts may call tmux CLI commands internally, which is safe because `run-shell` executes within the tmux server process itself (not as an external subprocess competing with control mode).
