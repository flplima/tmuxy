# Frontend State: Predictions, Input and Rendering

Optimistic updates, keystroke routing, user-facing errors and React integration. Part of [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).

### Optimistic Updates — TmuxClientModel

Optimistic state lives outside XState in a dedicated client model: `tmuxy-ui/src/domain/store/`. The model splits server-confirmed state from in-flight predictions and replays predictions on top.

| Concept | Lives in | Purpose |
| --- | --- | --- |
| `committed` | `TmuxClientModel.committed` | Last server-confirmed snapshot (panes, windows, active\*). |
| `ops` | `TmuxClientModel.ops` | Ordered log of in-flight optimistic operations. |
| `derived` | `TmuxClientModel.derived` | `committed` with every `ops[i].patch` replayed in order. UI reads this. |
| `paneKeyOverrides` | `TmuxClientModel` | Maps real pane IDs to placeholder IDs so React keys stay stable. |

A `TmuxOp` is a typed value, not a parsed command string. The store knows how to:

1. **Predict** — `ops.ts`'s `predict(op, snapshot, ctx) → Patch | null` produces the patch applied on top of `committed`. The predict context (default shell + MRU pane activation order for the Navigate tiebreak) is mirrored from the machine on every model update via `UPDATE_PREDICT_CONTEXT`.
2. **Dispatch** — `TmuxStore.dispatch(op)` runs predict → applies the patch → marks the op `in-flight` → sends the command through the adapter → rolls the patch back if the send fails. Once the adapter acks, the op moves to `awaiting-confirm`.
3. **Reconcile** — `TmuxStore.reconcile(serverState)` advances `committed`, runs each pending op's reconciler, drops matched/stale ones, recomputes `derived`.

Stale sweeping is status-aware: only an op the adapter was never asked to send (`pending`) is swept quickly (`OP_STALE_TIMEOUT_MS`) — its command may be a phantom with nothing coming. An op whose adapter call is still running (`in-flight`) is exempt from the quick sweep: the ack alone can outlast it on a slow transport (v86 serial, loaded server), the call is guaranteed to settle either way, and sweeping earlier blinks the optimistic UI away exactly when the backend is slowest. Both `in-flight` and acked (`awaiting-confirm`) ops fall to the longer `OP_ACKED_STALE_TIMEOUT_MS` backstop (the confirming delta may arrive slowly — e.g. a new window's type tag on a later list-windows sync). Rollbacks of structural ops surface in the snackbar via `TMUX_ERROR`; focus-op rollbacks stay console-only.

Predicted ops today: Split, NewWindow, SelectPane, Navigate (with the MRU tiebreak), Swap, SelectWindow, KillPane (removal + aligned-neighbor expansion + MRU refocus), KillWindow, RenameWindow, and ZoomToggle (zoom-in only — the pre-zoom slot is unknown client-side, so unzoom waits for the server). Deliberately NOT predicted: break-pane, layout cycling, and plain resizes (server-side layout math), plus keystrokes (see NON-GOALS.md). While ops are pending the store also re-reconciles on a timer, so age-based verdicts fire even when the control stream is idle.

Focus ops (SelectPane / Navigate) additionally **linger** after confirmation (`FOCUS_CONFIRM_LINGER_MS`): snapshots computed before the focus change can arrive after it, and dropping the op's pin on first confirmation would flap the highlight. A confirmed-then-superseded focus (the server reports a third pane past `FOCUS_SUPERSEDE_GRACE_MS`) yields to the server immediately. Placeholder ids (`__placeholder_*`) are client-only: the keyboardActor never targets them (it falls back to no pane target while a placeholder is active — commands queue FIFO, so by execution time tmux's own active pane is the pane the placeholder stands for).

### Keystroke-routing contract

Anything that changes the user's perceived "focused pane" MUST keep three pieces of state in lockstep, or keystrokes will land in the wrong pane during the brief window before tmux confirms the change:

| State | Owner | Why it matters |
| --- | --- | --- |
| `context.activePaneId` | appMachine | Drives the UI focus indicator (PaneHeader tab highlight, pane border, etc.). |
| `activePaneId` (local) | keyboardActor | Resolved as the `-t` target for every `send-keys`, paste, and IME-commit command: a focused overlay (float, dock) wins, then the active pane, then the session name; a placeholder id at either step falls through to the session. The hidden keyboard input is re-aimed on every change. |
| Server-side active pane | tmux | Used by any prefix/root binding that omits `-t` (e.g., `split-window`). |

Rules an action that flips focus must follow:

1. **Set `activePaneId` in context** — via `assign({ activePaneId: ... })`.
2. **Push `UPDATE_ACTIVE_PANE` to the keyboard actor** — so the next keypress already targets the new pane. The keyboardActor stores `activePaneId` as a local variable (see `tmuxy-ui/src/machines/actors/keyboardActor.ts`) and only updates it on this event.
3. **Don't trust tmux's active pane** — for the third case, prefix and root bindings are auto-pinned at dispatch time: keyboardActor prepends `select-pane -t <activePaneId> \;` to every binding command. New code should not bypass this.

Reference implementations: `SELECT_TAB` (top tab clicks) and `SELECT_PANE_GROUP_TAB` (pane-group tab clicks) in `appMachine.ts`. Pane-group prev/next, tab next/prev/last, and Ctrl+1..9 all route through these via `resolveTabNavTarget` / `resolvePaneGroupNavTarget` so they share the same optimism.

### Errors and messages the user sees

There is one surface for errors: the snackbar (`components/Snackbar.tsx`),
stacked in the top-right corner of the app chrome, each entry with a close
button and an expiry. It renders the `notifications` field, owned by the
`notifications` slice; anything that has an error for the user
raises `NOTIFY { text }` — the connected-state `TMUX_ERROR` handler (backend
errors, rejected commands, optimistic rollbacks), a refused clipboard write,
a menu action that cannot run on this transport. The same text arriving while
still on screen refreshes the entry rather than stacking a duplicate.

tmux's own messages share the corner. A `display-message` aimed at the
control client reaches it as a `%message` notification (tmux 3.4+; older tmux
sends nothing). The parser strips its control characters and caps its length,
the monitor hands it straight to the emitter (`show_message`, never through
the aggregator), and it goes out as `tmux-message` on SSE and on the desktop
event channel. The tmux actor raises `NOTIFY { text, kind: 'info' }`: the same
card in a neutral border, a `status` rather than an `alert`. Because the client
no longer intercepts `display-message`, tmux expands its formats
(`display-message '#{pane_current_path}'` shows the path). With a second client
attached, tmux sends the message to the most recently active one.

The status line (`statusMessage`, commandUi) is for the client's own status —
"Copied …" — never errors. While the app is still connecting, the connection
overlay shows the transient `error` instead, so the same message is not shown
twice.

### React Integration

Components consume the machine via hooks defined in `tmuxy-ui/src/machines/appHooks.ts`:

- `useAppSelector(selector)` — Subscribe to derived state
- `useAppSend()` — Get event sender function
- `useAppState(stateValue)` — Check current machine state
- `usePane(paneId)` — Get a single pane by ID
- `usePaneGroup(paneId)` — Get group info for a pane
- `useIsDragging()`, `useIsResizing()` — Operation state checks

Selectors are defined in `tmuxy-ui/src/machines/selectors/` (`layout.ts`, `panesAndSidebars.ts`, `ui.ts`) and include: `selectPreviewPanes` (with resize preview), `selectVisiblePanes`, `selectWindows`, `selectVisibleWindows`, `selectGridDimensions`, `selectCharSize`, `selectPaneById`, `selectPaneGroupForPane`, etc.

### Pane enter/leave animations (component-local)

Split and kill morphs are deliberately **not** machine state — the lifecycle lives entirely in `tmuxy-ui/src/components/PaneLayout.tsx` as refs plus a tick reducer. Each render is diffed against a snapshot of the previous render, keyed by the pane's effective React key (`paneKeyOverrides` honored, so the optimistic placeholder→real-id swap never re-triggers an animation):

- **Enter** (split): a newly visible key mounts at its final geometry, is FLIP-rewound before paint to the pre-split box of the sibling that shrank for it, then transitions into place while fading in (`pane-entering`).
- **Leave** (kill): the closed pane's node goes away in the same commit that drops it from the model; only the survivors animate, growing into the freed space (`pane-shifting`).
- **Shift**: pre-existing panes whose geometry changed alongside an enter/leave animate on the same clock (`pane-shifting`) so converging edges track.

The from/to geometry is inferred generically from previous-render pixel boxes (`tmuxy-ui/src/utils/paneTransitions.ts`), so splits/kills initiated from the CLI or another client animate identically to optimistic local ones. The lifecycle classes intentionally out-specify the `enableAnimations`/`suppressLayoutTransition` container gates in CSS; detection is skipped on initial load, window switches, and during drag/resize.

---
