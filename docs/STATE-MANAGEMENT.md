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

### AppState

The top-level server state, defined in `tmuxy-server/src/state.rs`. Holds:

- `sessions` — A `HashMap<String, SessionConnections>` mapping session names to their connection state. Protected by `RwLock` for concurrent access.
- `next_conn_id` — Atomic counter for generating unique connection IDs (starts at 1).
- `sse_tokens` — Maps session tokens to `(connection_id, session_name)` pairs for HTTP POST authentication.

### SessionConnections

Per-session connection tracking, also in `tmuxy-server/src/state.rs`. One instance per tmux session, shared by all clients connected to that session:

- `connections` — Ordered list of active connection IDs.
- `client_sizes` — Each client's reported viewport size (cols, rows) for minimum-size computation.
- `last_resize` — Last resize dimensions sent to tmux (avoids redundant commands).
- `monitor_command_tx` — Channel sender for commands to the session's `TmuxMonitor`.
- `state_tx` — Broadcast channel (capacity 100) for state updates, shared by all SSE clients.
- `monitor_handle` — Tokio task handle for the monitor (used to detect if the monitor has exited).

### TmuxMonitor

The core event loop, defined in `tmuxy-core/src/control_mode/monitor.rs`. Maintains a persistent `tmux -CC attach-session` subprocess:

- `connection` — The `ControlModeConnection` (stdin/stdout to the tmux subprocess).
- `aggregator` — The `StateAggregator` that processes control mode events into state updates.
- `config` — `MonitorConfig` with session name, sync intervals, throttle settings.
- `command_rx` — Receiver for `MonitorCommand` messages from the frontend.

The event loop uses `tokio::select!` with five branches: control mode events, throttle timer, settling timer, sync timer, and command channel. See [DATA-FLOW.md](DATA-FLOW.md) for the flow diagram.

### MonitorCommand

Enum with three variants (in `tmuxy-core/src/control_mode/monitor.rs`):

- `ResizeWindow { cols, rows }` — Resize all windows in the session.
- `RunCommand { command }` — Run an arbitrary tmux command through control mode stdin.
- `Shutdown` — Gracefully disconnect (sends `detach-client`, waits for clean exit).

### ControlModeConnection

Manages the `tmux -CC` subprocess, defined in `tmuxy-core/src/control_mode/connection.rs`:

- Spawns `tmux -CC` via a `script` wrapper for PTY allocation (initial size: 200x50).
- Spawns a background parser task that reads stdout line-by-line and converts to `ControlModeEvent` values.
- Provides `send_command()` and `send_commands_batch()` for writing to stdin.
- `graceful_close()` sends `detach-client` and waits — never kills the process abruptly (to avoid crashing tmux 3.5a).

### StateAggregator

Processes raw control mode events into structured state, defined in `tmuxy-core/src/control_mode/state.rs`. This is the largest component:

- `panes` — `HashMap<String, PaneState>` indexed by pane ID (`%0`, `%1`, etc.). Each `PaneState` contains a `vt100::Parser` terminal emulator, an `OscParser` for hyperlinks/clipboard, raw output buffer, position/size, cursor, metadata, copy mode state, and flow control flags.
- `windows` — `HashMap<String, WindowState>` indexed by window ID (`@0`, `@1`, etc.).
- `active_window_id` — Current active window.
- `pending_captures` — FIFO queue of pane IDs awaiting `capture-pane` responses.
- `prev_state` — Previous state snapshot for delta computation.
- `delta_seq` — Sequence number for delta ordering.
- `popup` — Active popup state (requires tmux PR #4361).
- `suppress_window_emissions` — Suppresses intermediate states during compound commands.

Key methods:
- `process_event()` — Takes a `ControlModeEvent`, updates internal state, returns what changed and which panes need refresh.
- `to_state_update()` — Computes a `StateUpdate` (full or delta) by diffing against `prev_state`.
- `force_emit()` — Clears suppression and emits consolidated state (called after settling).

### StateUpdate and TmuxState

The data structures sent to the frontend (defined in `tmuxy-core/src/lib.rs`):

**`StateUpdate`** is an enum: `Full { state: TmuxState }` for complete snapshots (initial sync, reconnection) or `Delta { delta: TmuxDelta }` for incremental updates.

**`TmuxState`** contains: `session_name`, `active_window_id`, `active_pane_id`, `panes` (list of `TmuxPane`), `windows` (list of `TmuxWindow`), `total_width/height`, `status_line` (rendered with ANSI escapes), and `popup`.

**`TmuxDelta`** contains only changed fields: `seq` (ordering), modified/removed panes and windows, new panes/windows, active pane/window changes, status line, dimensions, and popup state. `None` values mean "no change"; `Some(None)` means "removed".

### StateEmitter Trait

Adapter pattern for different backends, defined in `tmuxy-core/src/control_mode/monitor.rs`:

- `emit_state(StateUpdate)` — Emit a state change.
- `emit_error(String)` — Emit an error message.

Two implementations:
- `SseEmitter` (in `tmuxy-server/src/sse.rs`) — Serializes to JSON and sends through the session's broadcast channel to all SSE clients.
- `TauriEmitter` (in `tauri-app/src/monitor.rs`) — Emits Tauri events via `app.emit()` to the desktop frontend.

### Settling Mechanism

When compound commands are sent (e.g., `splitw ; breakp`), tmux fires multiple events in rapid succession. The settling mechanism prevents flashing intermediate states:

- When a command is sent, `settling_until` is set to `now + 100ms` (debounce).
- Window/layout emissions are suppressed during settling.
- Each new event resets the debounce timer (up to a 500ms maximum).
- When the timer expires, `force_emit()` sends the consolidated final state.

### Adaptive Throttling

For high-frequency terminal output (e.g., `yes | head -500`):

- The monitor tracks event rate over a 100ms window.
- If >20 events arrive in 100ms: switch to throttle mode, buffer output, and emit at 16ms intervals (~60fps).
- Below the threshold: emit immediately for low-latency typing feedback.

---

## Frontend State (XState)

### appMachine

The main state machine, defined in `tmuxy-ui/src/machines/app/appMachine.ts`. Three top-level states:

- **`connecting`** — Waiting for backend connection. Transitions to `idle` on `TMUX_CONNECTED`.
- **`idle`** — Main operational state. Handles all normal interactions.
- **`removingPane`** — Transient state for pane removal animations. Returns to `idle` when done.

### Machine Context

The context holds all frontend state. Key fields:

**From backend (synchronized via state updates):**
- `panes: TmuxPane[]` — All panes from tmux (content, cursor, dimensions, metadata)
- `windows: TmuxWindow[]` — All windows
- `activePaneId`, `activeWindowId` — Current focus
- `totalWidth`, `totalHeight` — tmux grid dimensions
- `statusLine` — Rendered tmux status line with ANSI codes
- `keybindings` — Prefix key and all bindings from tmux config
- `connectionId` — Server-assigned connection ID
- `defaultShell` — Default shell (bash, zsh, etc.)

**Client-only state:**
- `copyModeStates: Record<string, CopyModeState>` — Per-pane copy mode (entirely client-side, see [COPY-MODE.md](COPY-MODE.md))
- `drag: DragState | null` — Current pane drag operation
- `resize: ResizeState | null` — Current pane resize operation
- `paneGroups: Record<string, PaneGroup>` — Pane group tabs (hidden windows)
- `floatPanes: Record<string, FloatPaneState>` — Floating pane positions
- `commandMode` — Client-side command prompt (`:` mode)
- `paneActivationOrder` — Most-recently-used pane order
- `paneKeyOverrides` — Real-pane-id → placeholder-id mapping (mirrored from TmuxStore so React keys stay stable across optimistic-placeholder → real-pane id swaps)
- `charWidth`, `charHeight` — Monospace font dimensions (measured once)
- `targetCols`, `targetRows` — Browser viewport in character units
- `containerWidth`, `containerHeight` — Browser container pixel dimensions
- `themeName`, `themeMode`, `availableThemes` — Theme settings
- `enableAnimations` — CSS transitions toggle (disabled on load, enabled after state settles)

### Actors

The machine spawns three persistent actors:

**`tmuxActor`** (`tmuxy-ui/src/machines/actors/tmuxActor.ts`) — Bridge to the Rust backend. Receives `SEND_COMMAND`, `INVOKE`, `FETCH_INITIAL_STATE`, `FETCH_SCROLLBACK_CELLS`, etc. from the parent. Sends `TMUX_CONNECTED`, `TMUX_STATE_UPDATE`, `TMUX_ERROR`, `CONNECTION_INFO`, `KEYBINDINGS_RECEIVED`, `COPY_MODE_CHUNK_LOADED` to the parent.

**`keyboardActor`** (`tmuxy-ui/src/machines/actors/keyboardActor.ts`) — DOM keyboard input handling. Manages prefix mode (waits for next key after prefix), IME composition support (suppresses individual keydowns during CJK input), copy mode interception (all keys captured when active), root bindings (bypass prefix), and paste chunking (large pastes split into 500-char chunks). Sends `SEND_TMUX_COMMAND`, `KEY_PRESS`, and `COPY_SELECTION` to the parent.

**`sizeActor`** (`tmuxy-ui/src/machines/actors/sizeActor.ts`) — Viewport tracking. Measures monospace font char dimensions on start, listens to window resize (debounced 100ms), observes container with `ResizeObserver`. Sends `SET_CHAR_SIZE`, `SET_TARGET_SIZE`, `SET_CONTAINER_SIZE` to the parent.

### Child Machines

**`dragMachine`** (`tmuxy-ui/src/machines/drag/dragMachine.ts`) — Pane drag-to-swap. States: `idle` and `dragging`. During drag, finds swap targets based on cursor position and sends real-time `swap-pane` commands. Updates the parent's `drag` context via `DRAG_STATE_UPDATE`.

**`resizeMachine`** (`tmuxy-ui/src/machines/resize/resizeMachine.ts`) — Pane resize via divider dragging. States: `idle` and `resizing`. Tracks pixel delta, converts to character units, sends tmux `resize-pane` commands when delta >= 1 char. Throttles to avoid command spam.

### Optimistic Updates — TmuxClientModel (Tier 3)

Optimistic state lives outside XState in a dedicated client model: `tmuxy-ui/src/tmux/store/`. The model splits server-confirmed state from in-flight predictions and replays predictions on top.

| Concept              | Lives in                       | Purpose                                                                 |
|----------------------|--------------------------------|-------------------------------------------------------------------------|
| `committed`          | `TmuxClientModel.committed`    | Last server-confirmed snapshot (panes, windows, active*).               |
| `ops`                | `TmuxClientModel.ops`          | Ordered log of in-flight optimistic operations.                         |
| `derived`            | `TmuxClientModel.derived`      | `committed` with every `ops[i].patch` replayed in order. UI reads this. |
| `paneKeyOverrides`   | `TmuxClientModel`              | Maps real pane IDs to placeholder IDs so React keys stay stable.        |

A `TmuxOp` is a typed value, not a parsed command string. The store knows how to:
1. **Predict** — `ops.ts`'s `predict(op, snapshot, ctx) → Patch | null` produces the patch applied on top of `committed`.
2. **Dispatch** — `TmuxStore.dispatch(op)` runs predict → applies the patch → sends the command through the adapter → on `TmuxError` rolls the patch back.
3. **Reconcile** — `TmuxStore.reconcile(serverState)` advances `committed`, runs each pending op's reconciler, drops matched/stale ones, recomputes `derived`.

The XState `appMachine` is a thin bridge: `SEND_TMUX_COMMAND` routes to `tmuxStoreActor` → `store.dispatch`; `TMUX_STATE_UPDATE` routes to `tmuxStoreActor` → `store.reconcile`. Every model change fires a `TMUX_MODEL_UPDATE` event back to the parent, where context.panes/windows/activePaneId are mirrored from `model.derived`. The 600+ lines of split-anti-flicker, position-tolerance heuristics, and stale-timeout fallbacks that used to live inline in `appMachine.ts` are gone — the store owns all of it via pure reducers in `store/model.ts`.

### Keystroke-routing contract

Anything that changes the user's perceived "focused pane" MUST keep three pieces of state in lockstep, or keystrokes will land in the wrong pane during the brief window before tmux confirms the change:

| State                          | Owner                | Why it matters                                                                 |
|--------------------------------|----------------------|--------------------------------------------------------------------------------|
| `context.activePaneId`         | appMachine           | Drives the UI focus indicator (PaneHeader tab highlight, pane border, etc.).   |
| `activePaneId` (local)         | keyboardActor        | Used as the `-t` target for every `send-keys`, paste, and IME-commit command.  |
| Server-side active pane        | tmux                 | Used by any prefix/root binding that omits `-t` (e.g., `split-window`).        |

Rules an action that flips focus must follow:

1. **Set `activePaneId` in context** — via `assign({ activePaneId: ... })`.
2. **Push `UPDATE_ACTIVE_PANE` to the keyboard actor** — so the next keypress already targets the new pane. The keyboardActor stores `activePaneId` as a local variable (see `tmuxy-ui/src/machines/actors/keyboardActor.ts`) and only re-reads it on this event or on `TMUX_STATE_UPDATE`.
3. **Don't trust tmux's active pane** — for the third case, prefix and root bindings are auto-pinned at dispatch time: keyboardActor prepends `select-pane -t <activePaneId> \;` to every binding command. New code should not bypass this.

Reference implementations: `SELECT_TAB` (top tab clicks) and `SELECT_PANE_GROUP_TAB` (pane-group tab clicks) in `appMachine.ts`. Pane-group prev/next, tab next/prev/last, and Ctrl+1..9 all route through these via `resolveTabNavTarget` / `resolvePaneGroupNavTarget` so they share the same optimism.

### Parallel-state decomposition (Option D′)

`appMachine.ts` is decomposed into per-concern files under `tmuxy-ui/src/machines/app/`:

```
machines/app/
├── appMachine.ts          # Parent: lifecycle (connecting / idle / removingPane),
│                          # actor wiring, cross-cutting orchestrators
│                          # (SEND_TMUX_COMMAND optimistic intercept,
│                          # TMUX_STATE_UPDATE reconciliation, FOCUS_PANE,
│                          # SELECT_PANE_GROUP_TAB, DRAG_START, COPY_SELECTION,
│                          # CREATE_TAB).
├── context.ts             # createInitialContext() and FIELD_OWNERS registry
├── tmuxStateSlices.ts     # Per-state slice helpers for TMUX_STATE_UPDATE
│                          # (sliceCopyModeStates, sliceStatusLine,
│                          # sliceActivationOrder, sliceLastActivePaneByWindow,
│                          # detectRemovedPanes).
├── helpers.ts             # transformServerState, parseCommandPrompt,
│                          # parseDisplayMessage, STATUS_MESSAGE_DURATION.
├── states/                # One file per parallel state — exports the state
│   │                      # config (on: slice) referenced by named actions.
│   ├── uiPrefs.ts         # theme, font size, animations
│   ├── commandUi.ts       # command mode, status messages, prefix indicator
│   ├── copyMode.ts        # client-side copy mode (per-pane CopyModeState)
│   ├── groupsAndFloats.ts # pane groups, float panes, group-switch freeze
│   └── layout.ts          # panes, windows, focus, drag/resize, optimistic
├── actions/               # Named action implementations referenced by
│                          # states/<name>.ts via string IDs. Spread into
│                          # setup({ actions: { ...uiPrefsActions, ... }}).
└── guards/                # Named guards (currently empty placeholders).
```

**One-owner-per-field invariant.** `FIELD_OWNERS` in `context.ts` maps every
`AppMachineContext` field to its owning state (`'layout' | 'copyMode' |
'groupsAndFloats' | 'commandUi' | 'uiPrefs' | 'parent'`). The
`tmuxy/state-field-ownership` ESLint rule (in `packages/tmuxy-ui/eslint-rules/`)
enforces this: any `assign({...})` inside a `states/<name>.ts` or
`actions/<name>.ts` file may only mutate fields owned by `<name>`.
Cross-cutting handlers that legitimately span states opt out with a
`// cross-cutting: <reason>` comment on the assign.

Action names are prefixed with the owning state (`uiPrefs_applyTheme`,
`layout_selectTab`, etc.) so they don't collide when merged into the
parent's `setup({ actions })` block.

### Effect-based protocol boundary

The async/IO layer between adapters and `tmuxActor` uses Effect for typed
errors, structured concurrency, and schema-validated decoding. Files under
`tmuxy-ui/src/tmux/effect/`:

- **`AdapterError.ts`** — Tagged union failure type:
  `TransportError | ProtocolError | TmuxError | Cancelled`. The Rust backend's
  `{ error: '...' }` rejection shape is auto-classified as `TmuxError`.
- **`EffectTmuxAdapter.ts`** — `toEffectAdapter(adapter)` wraps the
  Promise-based `TmuxAdapter` interface into Effect-returning methods.
  `decodingInvoke(cmd, schema, args)` composes invoke + Schema.decodeUnknown
  so decode failures surface as `ProtocolError`, distinct from network
  (`TransportError`) and tmux command failures (`TmuxError`).
- **`schemas.ts`** — Effect Schema mirrors of the wire shapes
  (`ServerState`, `ServerDelta`, `StateUpdate`, `KeyBindings`, and substructures).
- **`decoders.ts`** — `decodeStateUpdate / decodeServerState / decodeServerDelta /
  decodeKeyBindings` — each `(raw: unknown) => Effect<T, ProtocolError>`.
- **`sseStream.ts`** — `eventSourceStream(url, {events})` returns
  `Stream<SseEvent, AdapterError>` over browser EventSource, with deterministic
  cleanup via `Effect.acquireRelease` and composable retry via `Stream.retry`.
- **`compoundOps.ts`** — Reference compound operations like
  `createAndRenameWindow` and `withTemporaryWindow` that demonstrate
  multi-step transactions with explicit rollback.

**tmuxActor** consumes the Effect facade: every adapter call runs through
`Effect.runPromiseExit`, and errors tunnel to the parent machine as
`TMUX_ERROR { error: <display string>, tagged?: <AdapterError> }`.
Consumers can `switch (event.tagged?._tag)` for typed handling or fall back
to `event.error` for logging.

**Cancellable scrollback (Phase E4).** `FETCH_SCROLLBACK_CELLS` runs as an
`Effect.runFork` fiber tracked in a `Map<paneId, RuntimeFiber>`. A new
fetch for the same pane interrupts the prior fiber so its
`onSuccess` never fires — stale results never reach the parent.

### React Integration

Components consume the machine via hooks defined in `tmuxy-ui/src/machines/AppContext.tsx`:

- `useAppSelector(selector)` — Subscribe to derived state
- `useAppSend()` — Get event sender function
- `useAppState(stateValue)` — Check current machine state
- `usePane(paneId)` — Get a single pane by ID
- `usePaneGroup(paneId)` — Get group info for a pane
- `useCopyModeState(paneId)` — Get copy mode state for a pane
- `useIsDragging()`, `useIsResizing()` — Operation state checks

Selectors are defined in `tmuxy-ui/src/machines/selectors.ts` and include: `selectPreviewPanes` (with resize preview), `selectVisiblePanes`, `selectWindows`, `selectGridDimensions`, `selectPaneGroups`, `selectFloatPanes`, `selectIsConnected`, etc.

---

## How Backend and Frontend Stay in Sync

1. **Initial sync** — On connection, the frontend sends `get_initial_state` with viewport size. The backend responds with a full `TmuxState` snapshot. The frontend stores this as the base state.

2. **Incremental updates** — The backend sends `TmuxDelta` updates with sequence numbers. The frontend merges these via `handleStateUpdate()` in `tmuxy-ui/src/tmux/deltaProtocol.ts`. Only changed fields are transmitted.

3. **Sequence gaps** — If a delta arrives with an unexpected sequence number, the frontend requests a full resync.

4. **Optimistic reconciliation** — When the frontend has a pending optimistic operation and receives a state update, it validates the prediction. Matching predictions are confirmed; mismatches are overwritten by the server state.

5. **Copy mode divergence** — Copy mode state is entirely client-side (scrollback lines, cursor, selection). The only backend interaction is entering/exiting tmux's copy mode for the `in_mode` flag. See [COPY-MODE.md](COPY-MODE.md).

6. **Group state** — Pane groups are stored in tmux's session-level environment variable (`TMUXY_GROUPS` as compact JSON). The backend reads this on state sync and includes it in state updates. The frontend sends group mutations via `run-shell` commands that execute shell scripts in `bin/tmuxy/`.
