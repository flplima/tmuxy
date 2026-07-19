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

Top-level server state. Holds the per-session connection map, the execution context (`Ctx` — see below) for substitutable I/O, structured-shutdown handles (`JoinSet` + `CancellationToken`), and the shared image store. Exposes `tmux_call(args, op_name)` as the canonical async tmux entry point — every async handler routes through it rather than calling subprocesses directly.

See `tmuxy-server/src/state.rs`.

### SessionConnections

One per tmux session, shared by every client connected to that session. Owns the list of connected client IDs, each client's reported viewport size (for minimum-size computation), the channel to the session's `TmuxMonitor`, and the `SessionBroadcast` — a broadcast sender plus a ring-buffer + monotonic sequence id used for SSE `Last-Event-Id` resync (see [DATA-FLOW.md](DATA-FLOW.md)).

Same file as `AppState`.

### TmuxMonitor — the runtime

The bridge between the sans-IO state machine and a live `tmux -CC` subprocess. Receives control-mode events, drives the aggregator step-by-step, and executes the typed `SideEffect`s the aggregator returns (sending tmux commands, refreshing panes, emitting state). Multiplexes control-mode events, periodic syncs, the settling/throttle/debounce timers, and external commands from the frontend.

Takes an `Arc<Ctx>` so the clock, tmux dispatch, and filesystem are substitutable — tests can drive the loop without spinning a real tmux. The reconnect loop in the server/Tauri paths re-creates the monitor on disconnect with the same ctx.

See `tmuxy-core/src/control_mode/monitor.rs`. The split into per-event handler methods (`on_control_event`, `on_throttle_tick`, `on_settling_timeout`, etc.) is purely organisational — the docblocks on each method spell out the load-bearing ordering invariants.

### MonitorCommand

The typed envelope external code uses to drive the monitor (resize the window, run a tmux command through control mode, gracefully shut down). See the enum in `monitor.rs`; new variants get docblocks explaining *when* you'd send them, since the variant name alone isn't usually enough.

### ControlModeConnection

Manages the `tmux -CC` subprocess and the stdin/stdout framing on top of it. Spawns the subprocess under a PTY (via `script`), runs a background parser task that converts stdout lines into `ControlModeEvent`s, and exposes `send_command` / `send_commands_batch` for writes. `graceful_close()` always sends `detach-client` and waits — abrupt kills crash tmux 3.5a (see [TMUX.md](TMUX.md)).

See `tmuxy-core/src/control_mode/connection.rs`.

### StateAggregator — sans-IO state machine

The heart of the system. Consumes `ControlModeEvent`s and returns typed `SideEffect`s (`AdoptUntaggedWindows`, `RefreshPanes`, `EmitState { change }`, `StoreImages`, `WriteClipboard`, etc.). Performs no I/O itself — every command send, every emit, every image store is described, not performed. The runtime (`TmuxMonitor`) is what actually executes them.

This separation is what makes the aggregator testable without tokio: drive it with synthetic event sequences and assert on the returned effects. The settling mechanism (window-emission suppression during compound commands) lives here as a sticky flag the runtime arms/disarms; the time-based debounce/safety timer that decides *when* to disarm still lives in the monitor.

`step(event) -> StepResult` is the public entry point. `tick(now)` is reserved for future time-driven transitions and currently returns no effects.

See `tmuxy-core/src/control_mode/state.rs` and the `SideEffect` enum's docblocks for the ordering invariants the runtime relies on.

### Ctx — execution context

A small bundle of substitutable capabilities (`TmuxCommand`, `Clock`, `FileSystem`) plus a `RetryPolicy`. Production uses `Ctx::live()` (real subprocess, system clock, on-disk FS). Tests use `test_ctx()` (mock tmux that records argvs, fake clock, in-memory FS) — gated behind a `test-support` cargo feature so external integration tests can pull in the mocks.

See `tmuxy-core/src/ctx.rs`.

### Tower stack — async tmux call boundary

Async hot paths that need to dispatch one-off tmux commands go through a Tower middleware stack: `TraceLayer → RetryLayer → TimeoutLayer → TmuxService`. `build_tmux_stack(ctx_tmux, timeout, policy)` is the single composition point; `AppState::tmux_call` is the consumer-side helper. Configuration (per-call timeout, retry policy) is changed in one place.

Sync `executor::*` helpers continue to call subprocesses directly because they cannot await — they're used from CLI paths and from background `spawn_blocking` contexts. The Tower stack is for the async paths.

See `tmuxy-core/src/tmux_service.rs`.

### StateUpdate, TmuxState, TmuxDelta

The wire-shaped types the backend emits. `StateUpdate` is either a `Full` snapshot (initial sync, full resync) or a `Delta` (sequenced incremental change). The delta encoding distinguishes "no change" from "removed" so the frontend's reconciliation is unambiguous.

See `tmuxy-core/src/lib.rs`. The TypeScript mirrors live in `tmuxy-ui/src/tmux/effect/schemas.ts` and are validated via Effect Schema on every receive.

### StateEmitter trait

The seam between the monitor and a specific transport. Two implementations:
- `SseEmitter` (`tmuxy-server/src/sse.rs`) — broadcasts via `SessionBroadcast` to every SSE client in the session.
- `TauriEmitter` (`packages/tmuxy-tauri-app/src/monitor.rs`) — emits Tauri events to the desktop frontend.

The trait keeps `TmuxMonitor` transport-agnostic; adding a third transport means implementing the trait, nothing else.

### Settling, throttling, debouncing

Three timing policies the monitor applies on top of the aggregator's effects. All are about *when* to flush state, not *what* the state contains.

- **Settling** suppresses intermediate window/layout emissions while a compound command (`splitw ; breakp ; set-option ...`) is mid-flight. The aggregator owns the suppression flag; the monitor owns the debounce/safety timer that decides when to disarm it.
- **Adaptive throttling** caps state emissions during high-frequency output (rate-window hysteresis with a ~60fps ceiling) so terminal-output bursts don't drown the SSE channel. Below the threshold, emissions are immediate for low-latency typing feedback.
- **Layout debounce** coalesces rapid layout changes (e.g., zoom-out cascades) into a single emission.

Tunables live on `MonitorConfig`. The exact durations + thresholds drift as we tune for real workloads; the durable contract is "the aggregator is correct; the monitor decides cadence."

---

## Frontend State (XState)

### appMachine

The main state machine, defined in `tmuxy-ui/src/machines/app/appMachine.ts`. Four top-level states arranged as a connection lifecycle:

- **`connecting`** — Initial. Waiting for the backend handshake. Transitions to `idle` on `TMUX_CONNECTED`.
- **`idle`** — Live and operational. Handles all normal interactions. The "syncing" sub-flavor — connected, but with one or more optimistic ops in flight — is a derived flag (`tmuxStore.model.ops.length > 0`) surfaced to selectors; it does not gate any handlers, so the user never feels a perceptible mode change when an op is pending.
- **`reconnecting`** — The adapter detected the SSE/Tauri channel dropped and is retrying. Distinct from `connecting` so the UI keeps the stale layout mounted and overlays a "reconnecting…" banner. Transitions to `idle` on `TMUX_RECONNECTED` (next live snapshot) or `disconnected` on `TMUX_DISCONNECTED` / `TMUX_FATAL`.
- **`disconnected`** — Terminal. Backend gave up or an explicit disconnect happened. The status screen reads `fatalError` to show a non-recoverable banner. No auto-recovery; an adapter-initiated `TMUX_RECONNECTING` is still accepted, so a server that comes back later can pull the UI out of this state.

Reconnection flow: the adapter (`HttpAdapter` / `TauriAdapter`) tracks the retry attempt count and fires `onReconnection(true, attempt)` on every drop. `tmuxActor` forwards this as `TMUX_RECONNECTING { attempt }`; the machine assigns `context.reconnectAttempt` and transitions to `reconnecting`. When the channel recovers, the adapter fires `onReconnection(false, 0)` → `TMUX_RECONNECTED` → back to `idle`. Pending optimistic ops carry across reconnection: the store's `applyServerSnapshot` runs against the first post-recovery full state and reconciles or rolls back each op (stale ops older than `OP_STALE_TIMEOUT_MS` are dropped in that same pass).

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

The machine invokes five persistent actors:

**`tmuxActor`** (`tmuxy-ui/src/machines/actors/tmuxActor.ts`) — Bridge to the Rust backend. Receives `SEND_COMMAND`, `INVOKE`, `FETCH_INITIAL_STATE`, `FETCH_THEME_SETTINGS`, etc. from the parent. Sends `TMUX_CONNECTED`, `TMUX_STATE_UPDATE`, `TMUX_ERROR`, `CONNECTION_INFO`, `KEYBINDINGS_RECEIVED`, `TMUX_CLIPBOARD` to the parent.

**`tmuxStoreActor`** (`tmuxy-ui/src/machines/actors/tmuxStoreActor.ts`) — Bridges the Tier-3 client model (`TmuxStore`) into XState. Receives `DISPATCH_COMMAND` (optimistic dispatch) and `RECONCILE_SERVER` (server snapshot reconciliation) from the parent; forwards every model change back as `TMUX_MODEL_UPDATE`.

**`keyboardActor`** (`tmuxy-ui/src/machines/actors/keyboardActor.ts`) — DOM keyboard input handling. Manages prefix mode (waits for next key after prefix), IME composition support (suppresses individual keydowns during CJK input), copy mode interception (all keys captured and sent as `COPY_MODE_KEY` when the active pane is in client-side copy mode), root bindings (bypass prefix), and paste chunking (large pastes split into 500-char chunks). Sends `SEND_TMUX_COMMAND`, `KEY_PRESS`, and `COPY_SELECTION` to the parent.

**`sizeActor`** (`tmuxy-ui/src/machines/actors/sizeActor.ts`) — Viewport tracking. Measures monospace font char dimensions on start, listens to window resize (debounced 100ms), observes container with `ResizeObserver`. Sends `SET_CHAR_SIZE`, `SET_TARGET_SIZE`, `SET_CONTAINER_SIZE` to the parent.

**`serversActor`** (`tmuxy-ui/src/machines/actors/serversActor.ts`) — Polls the sessions tree for the sidebar (runs on web and desktop when the adapter sets `enumeratesSessions`).

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
1. **Predict** — `ops.ts`'s `predict(op, snapshot, ctx) → Patch | null` produces the patch applied on top of `committed`. The predict context (default shell + MRU pane activation order for the Navigate tiebreak) is mirrored from the machine on every model update via `UPDATE_PREDICT_CONTEXT`.
2. **Dispatch** — `TmuxStore.dispatch(op)` runs predict → applies the patch → marks the op `in-flight` → sends the command through the adapter → on `TmuxError` rolls the patch back. Once the adapter acks, the op moves to `awaiting-confirm`.
3. **Reconcile** — `TmuxStore.reconcile(serverState)` advances `committed`, runs each pending op's reconciler, drops matched/stale ones, recomputes `derived`.

Stale sweeping is status-aware: only an op the adapter was never asked to send (`pending`) is swept quickly (`OP_STALE_TIMEOUT_MS`) — its command may be a phantom with nothing coming. An op whose adapter call is still running (`in-flight`) is exempt from the quick sweep: the ack alone can outlast it on a slow transport (v86 serial, loaded server), the call is guaranteed to settle either way, and sweeping earlier blinks the optimistic UI away exactly when the backend is slowest. Both `in-flight` and acked (`awaiting-confirm`) ops fall to the longer `OP_ACKED_STALE_TIMEOUT_MS` backstop (the confirming delta may arrive slowly — e.g. a new window's type tag on a later list-windows sync). Rollbacks of structural ops surface to the status line via `TMUX_ERROR`; focus-op rollbacks stay console-only.

Predicted ops today: Split, NewWindow, SelectPane, Navigate (with the MRU tiebreak), Swap, SelectWindow, KillPane (removal + aligned-neighbor expansion + MRU refocus), KillWindow, RenameWindow, and ZoomToggle (zoom-in only — the pre-zoom slot is unknown client-side, so unzoom waits for the server). Deliberately NOT predicted: break-pane, layout cycling, and plain resizes (server-side layout math), plus keystrokes (see NON-GOALS.md). While ops are pending the store also re-reconciles on a timer, so age-based verdicts fire even when the control stream is idle.

Focus ops (SelectPane / Navigate) additionally **linger** after confirmation (`FOCUS_CONFIRM_LINGER_MS`): snapshots computed before the focus change can arrive after it, and dropping the op's pin on first confirmation would flap the highlight. A confirmed-then-superseded focus (the server reports a third pane past `FOCUS_SUPERSEDE_GRACE_MS`) yields to the server immediately. Placeholder ids (`__placeholder_*`) are client-only: the keyboardActor never targets them (it falls back to no pane target while a placeholder is active — commands queue FIFO, so by execution time tmux's own active pane is the pane the placeholder stands for).

The XState `appMachine` is a thin bridge: `SEND_TMUX_COMMAND` routes to `tmuxStoreActor` → `store.dispatch`; `TMUX_STATE_UPDATE` routes to `tmuxStoreActor` → `store.reconcile`. Every model change fires a `TMUX_MODEL_UPDATE` event back to the parent, where context.panes/windows/activePaneId are mirrored from `model.derived`. The 600+ lines of split-anti-flicker, position-tolerance heuristics, and stale-timeout fallbacks that used to live inline in `appMachine.ts` are gone — the store owns all of it via pure reducers in `store/model.ts`.

### Keystroke-routing contract

Anything that changes the user's perceived "focused pane" MUST keep three pieces of state in lockstep, or keystrokes will land in the wrong pane during the brief window before tmux confirms the change:

| State                          | Owner                | Why it matters                                                                 |
|--------------------------------|----------------------|--------------------------------------------------------------------------------|
| `context.activePaneId`         | appMachine           | Drives the UI focus indicator (PaneHeader tab highlight, pane border, etc.).   |
| `activePaneId` (local)         | keyboardActor        | Resolved as the `-t` target for every `send-keys`, paste, and IME-commit command: a focused float pane wins, then the active pane (placeholder ids filtered out), then the session name. |
| Server-side active pane        | tmux                 | Used by any prefix/root binding that omits `-t` (e.g., `split-window`).        |

Rules an action that flips focus must follow:

1. **Set `activePaneId` in context** — via `assign({ activePaneId: ... })`.
2. **Push `UPDATE_ACTIVE_PANE` to the keyboard actor** — so the next keypress already targets the new pane. The keyboardActor stores `activePaneId` as a local variable (see `tmuxy-ui/src/machines/actors/keyboardActor.ts`) and only updates it on this event.
3. **Don't trust tmux's active pane** — for the third case, prefix and root bindings are auto-pinned at dispatch time: keyboardActor prepends `select-pane -t <activePaneId> \;` to every binding command. New code should not bypass this.

Reference implementations: `SELECT_TAB` (top tab clicks) and `SELECT_PANE_GROUP_TAB` (pane-group tab clicks) in `appMachine.ts`. Pane-group prev/next, tab next/prev/last, and Ctrl+1..9 all route through these via `resolveTabNavTarget` / `resolvePaneGroupNavTarget` so they share the same optimism.

### Parallel-state decomposition (Option D′)

`appMachine.ts` is decomposed into per-concern files under `tmuxy-ui/src/machines/app/`:

```
machines/app/
├── appMachine.ts          # Parent: lifecycle (connecting / idle / reconnecting),
│                          # actor wiring, cross-cutting orchestrators.
│                          # SEND_TMUX_COMMAND keeps its keybinding intercepts
│                          # (copy-mode, command-prompt, display-message, tab
│                          # remap) but the optimistic-apply path is now a
│                          # one-liner sendTo('tmuxStore', DISPATCH_COMMAND).
│                          # TMUX_STATE_UPDATE is one-liner sendTo('tmuxStore',
│                          # RECONCILE_SERVER); the TMUX_MODEL_UPDATE handler
│                          # mirrors the model into context directly via
│                          # snapshotFromModel, then runs the heavy downstream
│                          # work (groups, floats, copy-mode detect, animations).
├── context.ts             # createInitialContext() and FIELD_OWNERS registry
├── helpers.ts             # transformServerState, parseCommandPrompt,
│                          # parseDisplayMessage, STATUS_MESSAGE_DURATION.
├── states/                # One file per parallel state — exports the state
│   │                      # config (on: slice) referenced by named actions.
│   ├── uiPrefs.ts         # theme, font size, animations
│   ├── commandUi.ts       # command mode, status messages, prefix indicator
│   ├── copyMode.ts        # client-side copy mode (per-pane CopyModeState)
│   ├── groupsAndFloats.ts # pane groups, float panes, group-switch freeze
│   └── layout.ts          # panes, windows, focus, drag/resize
│                          # (optimistic state lives in src/tmux/store/, not here)
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

### React Integration

Components consume the machine via hooks defined in `tmuxy-ui/src/machines/AppContext.tsx`:

- `useAppSelector(selector)` — Subscribe to derived state
- `useAppSend()` — Get event sender function
- `useAppState(stateValue)` — Check current machine state
- `usePane(paneId)` — Get a single pane by ID
- `usePaneGroup(paneId)` — Get group info for a pane
- `useIsDragging()`, `useIsResizing()` — Operation state checks

Selectors are defined in `tmuxy-ui/src/machines/selectors.ts` and include: `selectPreviewPanes` (with resize preview), `selectVisiblePanes`, `selectWindows`, `selectVisibleWindows`, `selectGridDimensions`, `selectCharSize`, `selectPaneById`, `selectPaneGroupForPane`, etc.

### Pane enter/leave animations (component-local)

Split and kill morphs are deliberately **not** machine state — the lifecycle lives entirely in `tmuxy-ui/src/components/PaneLayout.tsx` as refs plus a tick reducer. Each render is diffed against a snapshot of the previous render, keyed by the pane's effective React key (`paneKeyOverrides` honored, so the optimistic placeholder→real-id swap never re-triggers an animation):

- **Enter** (split): a newly visible key mounts at its final geometry, is FLIP-rewound before paint to the pre-split box of the sibling that shrank for it, then transitions into place while fading in (`pane-entering`).
- **Leave** (kill): a key that vanishes from the render keeps its DOM node mounted for the leave duration, morphing into the absorber's expanded box while fading out (`pane-leaving`). Its frozen pane snapshot is exposed through `LeavingPanesContext` (`tmuxy-ui/src/machines/LeavingPanesContext.ts`), which `usePane` falls back to after the model has dropped the pane.
- **Shift**: pre-existing panes whose geometry changed alongside an enter/leave animate on the same clock (`pane-shifting`) so converging edges track.

The from/to geometry is inferred generically from previous-render pixel boxes (`tmuxy-ui/src/utils/paneTransitions.ts`), so splits/kills initiated from the CLI or another client animate identically to optimistic local ones. The lifecycle classes intentionally out-specify the `enableAnimations`/`suppressLayoutTransition` container gates in CSS; detection is skipped on initial load, window switches, and during drag/resize.

---

## How Backend and Frontend Stay in Sync

1. **Initial sync** — On connection, the frontend sends `get_initial_state` with viewport size. The backend responds with a full `TmuxState` snapshot. The frontend stores this as the base state.

2. **Incremental updates** — The backend sends `TmuxDelta` updates with sequence numbers. The frontend merges these via `handleStateUpdate()` in `tmuxy-ui/src/tmux/deltaProtocol.ts`. Only changed fields are transmitted.

3. **Sequence gaps** — If a delta arrives with an unexpected sequence number, the frontend requests a full resync.

4. **Optimistic reconciliation** — Every dispatched op stays in `TmuxClientModel.ops` until a server state update either matches it (the predicted real id appears in `committed`) or it stale-expires after `OP_STALE_TIMEOUT_MS`. Multiple in-flight ops are reconciled in dispatch order, each claiming its own real id so concurrent Split / NewWindow ops don't collide. On `TmuxError`, the store rolls the patch back immediately and surfaces `OpRejectedByTmux { stderr }` to the caller.

5. **Copy mode is client-side** — the `copyMode` parallel state owns per-pane `CopyModeState` (loaded scrollback `lines`, cursor, selection, scrollTop). Scrollback is fetched on demand from tmux (`FETCH_SCROLLBACK_CELLS` → `get_scrollback_cells` → `COPY_MODE_CHUNK_LOADED`) and rendered in a natively-scrolling container; vi keybindings (via `COPY_MODE_KEY` → `handleCopyModeKey`), cursor movement, mouse selection, and scroll position are all client-owned. The only backend interaction is entering/exiting tmux's copy mode for the `in_mode` flag and capturing history. See [COPY-MODE.md](COPY-MODE.md).

6. **Group state** — Pane-group membership is stored in the `@tmuxy-group-panes` window option (a space-separated list of pane ids on the group's window; see [TMUX.md](TMUX.md) and [WINDOW-TAGS.md](WINDOW-TAGS.md)). The backend reads it on state sync and includes it in state updates. The frontend sends group mutations via `run-shell` commands that execute shell scripts in `bin/tmuxy/`.
