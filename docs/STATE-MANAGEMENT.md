# State Management

This document describes how state is managed on both the frontend (React + XState) and the backend (Rust), and how they stay synchronized.

## Overview

State flows unidirectionally from tmux through the Rust backend to the browser frontend:

```
tmux server → ControlModeConnection → StateAggregator → StateEmitter → Frontend XState
```

The backend maintains the **authoritative** tmux state. The frontend maintains a **derived** copy with additional client-only state (copy mode, drag, resize, animations, UI preferences). The delta protocol keeps them synchronized.

---

## Backend State (Rust)

The backend is the **authoritative** owner of tmux state. Everything below is a layer that exists to make that ownership testable, resilient, and shareable across multiple clients. Component shape and field-by-field details live in the source — this section describes **roles and contracts**.

### AppState

Top-level server state. Holds the per-session connection map, structured-shutdown handles (`JoinSet` + `CancellationToken`), and the shared image store. Handlers reach tmux through the session's monitor, never a subprocess.

See `tmuxy-server/src/state.rs`.

### SessionConnections

One per tmux session, shared by every client connected to that session. Owns the list of connected client IDs, each client's reported viewport size (for minimum-size computation), the channel to the session's `TmuxMonitor`, and the `SessionBroadcast` — a broadcast sender plus a ring-buffer + monotonic sequence id used for SSE `Last-Event-Id` resync (see [DATA-FLOW.md](DATA-FLOW.md)).

Same file as `AppState`.

### TmuxMonitor — the runtime

The bridge between the sans-IO state machine and a live `tmux -CC` subprocess. Receives control-mode events, drives the aggregator step-by-step, and executes the typed `SideEffect`s the aggregator returns (sending tmux commands, refreshing panes, emitting state). Multiplexes control-mode events, periodic syncs, the settling/throttle/debounce timers, and external commands from the frontend.

The reconnect loop in the server/Tauri paths re-creates the monitor on disconnect. The monitor reads the system clock directly; the time-based policies it applies (`RunState`, the aggregator's `step_at`/`tick`) take an explicit instant, which is how their tests drive time without a tmux.

See `tmuxy-core/src/control_mode/monitor.rs`. The split into one handler method per `select!` arm is purely organisational — the docblocks on each method spell out the load-bearing ordering invariants. The monitor is generic over its link to tmux (`ControlLink`): the real control-mode PTY in production, a scripted one in tests, which is how the order it puts commands on the wire is asserted without a tmux (see [INVARIANTS.md](INVARIANTS.md), M1).

### MonitorCommand

The typed envelope external code uses to drive the monitor (resize the window, run a tmux command through control mode, gracefully shut down). See the enum in `monitor.rs`; new variants get docblocks explaining _when_ you'd send them, since the variant name alone isn't usually enough.

### ControlModeConnection

Manages the `tmux -CC` subprocess and the stdin/stdout framing on top of it. Spawns the subprocess under a PTY (via `script`), runs a background parser task that converts stdout lines into `ControlModeEvent`s, and exposes `send_command` / `send_commands_batch` for writes. `graceful_close()` always sends `detach-client` and waits — abrupt kills crash tmux 3.5a (see [TMUX.md](TMUX.md)).

See `tmuxy-core/src/control_mode/connection.rs`.

### StateAggregator — sans-IO state machine

The heart of the system. Consumes `ControlModeEvent`s and returns typed `SideEffect`s (`AdoptUntaggedWindows`, `RefreshPanes`, `EmitState { change }`, `StoreImages`, `WriteClipboard`, etc.). Performs no I/O itself — every command send, every emit, every image store is described, not performed. The runtime (`TmuxMonitor`) is what actually executes them.

This separation is what makes the aggregator testable without tokio: drive it with synthetic event sequences and assert on the returned effects. The settling mechanism (window-emission suppression during compound commands) lives here as a sticky flag the runtime arms/disarms; the time-based debounce/safety timer that decides _when_ to disarm still lives in the monitor.

`step(event) -> StepResult` is the public entry point. `tick(now)` drives the time-based transitions: once `now` passes the settling deadline after a burst of structural events, it ends the settling window and returns one consolidated `EmitState` (or nothing, when no event arrived during it).

See `tmuxy-core/src/control_mode/state.rs` and the `SideEffect` enum's docblocks for the ordering invariants the runtime relies on.

### StateUpdate, TmuxState, TmuxDelta

The wire-shaped types the backend emits. `StateUpdate` is either a `Full` snapshot (initial sync, full resync) or a `Delta` (sequenced incremental change). The delta encoding distinguishes "no change" from "removed" so the frontend's reconciliation is unambiguous.

See `tmuxy-core/src/lib.rs`. The TypeScript side is Effect Schemas in `tmuxy-ui/src/domain/wire.ts`; the TS types are derived from them and every update is decoded once where it enters the client.

### StateEmitter trait

The seam between the monitor and a specific transport. Two implementations:

- `SseEmitter` (`tmuxy-server/src/sse.rs`) — broadcasts via `SessionBroadcast` to every SSE client in the session.
- `TauriEmitter` (`packages/tmuxy-tauri-app/src/monitor.rs`) — emits Tauri events to the desktop frontend.

The trait keeps `TmuxMonitor` transport-agnostic; adding a third transport means implementing the trait, nothing else.

### Settling, throttling, debouncing

Three timing policies the monitor applies on top of the aggregator's effects. All are about _when_ to flush state, not _what_ the state contains.

- **Settling** suppresses intermediate window/layout emissions while a compound command (`splitw ; breakp ; set-option ...`) is mid-flight. The aggregator owns the suppression flag; the monitor owns the debounce/safety timer that decides when to disarm it.
- **Adaptive throttling** caps state emissions during high-frequency output (rate-window hysteresis with a ~60fps ceiling) so terminal-output bursts don't drown the SSE channel. Below the threshold, emissions are immediate for low-latency typing feedback.
- **Layout debounce** coalesces rapid layout changes (e.g., zoom-out cascades) into a single emission.

The tunables are constants in `control_mode/monitor.rs` (only the throttle interval is a `MonitorConfig` field). The exact durations + thresholds drift as we tune for real workloads; the durable contract is "the aggregator is correct; the monitor decides cadence."

---

## Frontend State (XState)

### appMachine

The main state machine, defined in `tmuxy-ui/src/machines/app/appMachine.ts`. Four top-level states arranged as a connection lifecycle:

- **`connecting`** — Initial. Waiting for the backend handshake. Transitions to `idle` on `TMUX_CONNECTED`. Like every live state it ends in `disconnected` on `TMUX_DISCONNECTED` / `TMUX_FATAL`, both handled at the machine root.
- **`idle`** — Live and operational. Handles all normal interactions. The "syncing" sub-flavor — connected, but with one or more optimistic ops in flight — is a derived flag (`tmuxStore.model.ops.length > 0`) surfaced to selectors; it does not gate any handlers, so the user never feels a perceptible mode change when an op is pending.
- **`reconnecting`** — The adapter detected the SSE/Tauri channel dropped and is retrying. Distinct from `connecting` so the UI keeps the last frame of the panes mounted and blurs it under the `ConnectionOverlay` (spinner + "Connecting…"; see `tmuxy-ui/src/components/ConnectionOverlay.tsx`). Transitions to `idle` on `TMUX_RECONNECTED` (next live snapshot) or `disconnected` on `TMUX_DISCONNECTED` / `TMUX_FATAL`.
- **`disconnected`** — Terminal. Backend gave up or an explicit disconnect happened. The `ConnectionOverlay` reads `fatalError` to show the one-line reason with a Retry button (a reload) and the command/error log behind a collapsed Details disclosure; the dead layout stays underneath as the blurred backdrop. No auto-recovery; an adapter-initiated `TMUX_RECONNECTING` is still accepted, so a server that comes back later can pull the UI out of this state.

Reconnection flow: the adapter (`HttpAdapter` / `TauriAdapter`) fires `onReconnection(true)` on every drop. `tmuxActor` forwards this as `TMUX_RECONNECTING` and the machine transitions to `reconnecting`. When the channel recovers, the adapter fires `onReconnection(false)` → `TMUX_RECONNECTED` → back to `idle`. Pending optimistic ops carry across reconnection: the store's `applyServerSnapshot` runs against the first post-recovery full state and reconciles or rolls back each op (stale ops older than `OP_STALE_TIMEOUT_MS` are dropped in that same pass).

See [STATE-MANAGEMENT-ACTORS.md](STATE-MANAGEMENT-ACTORS.md) for these sections: Machine Context; Actors; Child Machines; How the app machine is split; Domain and infrastructure.

See [STATE-MANAGEMENT-UPDATES.md](STATE-MANAGEMENT-UPDATES.md) for these sections: Optimistic Updates — TmuxClientModel; Read-only view focus; Keystroke-routing contract; Errors and messages the user sees; React Integration; Pane enter/leave animations (component-local).

## How Backend and Frontend Stay in Sync

1. **Initial sync** — On connection, the frontend sends `get_initial_state` with viewport size. The backend answers with the monitor's own `TmuxState` (`MonitorCommand::GetState`, the same picture its `Full` broadcast carries), so a client that connects after that broadcast — the desktop webview always does, its monitor starts first — begins from a baseline the deltas agree with. The frontend starts from it only until the stream has delivered its own full state: after that the stream is the state, and a later answer only fills panes the stream has no content for yet (`adoptInitialState` in `domain/deltaProtocol.ts`), since the answer sits outside the delta sequence and putting it back would undo what the stream delivered since.

2. **Incremental updates** — The backend sends `TmuxDelta` updates with sequence numbers. The frontend merges these via `handleStateUpdate()` in `tmuxy-ui/src/domain/deltaProtocol.ts`. Only changed fields are transmitted.

3. **Sequence gaps** — If a delta arrives with an unexpected sequence number, the frontend requests a full resync. A full state and the `get_initial_state` answer carry the sequence number they were taken at (`seq` on `TmuxState`), so the delta right after either is checked the same way: a delta lost between a sync point and the next delta is a gap, never a delta merged over a hole.

4. **Optimistic reconciliation** — Every dispatched op stays in `TmuxClientModel.ops` until a server state update either matches it (the predicted real id appears in `committed`) or it stale-expires after `OP_STALE_TIMEOUT_MS`. Multiple in-flight ops are reconciled in dispatch order, each claiming its own real id so concurrent Split / NewWindow ops don't collide. On `TmuxError`, the store rolls the patch back immediately and surfaces `OpRejectedByTmux { stderr }` to the caller.

5. **Copy mode is client-side** — the `copyMode` slice owns per-pane `CopyModeState` (loaded scrollback `lines`, cursor, selection, scrollTop). Scrollback is fetched on demand from tmux (`FETCH_SCROLLBACK_CELLS` → `get_scrollback_cells` → `COPY_MODE_CHUNK_LOADED`) and rendered in a natively-scrolling container; vi keybindings (via `COPY_MODE_KEY` → `handleCopyModeKey`), cursor movement, mouse selection, and scroll position are all client-owned. The only backend interaction is entering/exiting tmux's copy mode for the `in_mode` flag and capturing history. See [COPY-MODE.md](COPY-MODE.md).

6. **Group state** — Pane-group membership is intrinsic to the pane: every member carries the same `@tmuxy-group-id` pane option, the visible member lives in the attached session and the hidden ones are parked in the `__tmuxy_stash` session (see [TMUX.md](TMUX.md) "Window Tags"). The backend enumerates both on state sync and emits hidden members as pane stubs carrying `group_id`. The frontend sends group mutations via `run-shell` commands that execute shell scripts in `bin/tmuxy/`.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — where each state layer sits in the system
- [DATA-FLOW.md](DATA-FLOW.md) — the delta protocol and transports these updates travel over
- [TMUX.md](TMUX.md) — control-mode routing and the `@tmuxy-*` tags the window state is built from
- [COPY-MODE.md](COPY-MODE.md) — the client-owned `copyMode` slice
- [INVARIANTS.md](INVARIANTS.md) — the promises the aggregator, the monitor and the client model make to each other, and what tests them
