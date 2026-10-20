# Frontend State: Context, Actors and Layout

The app machine's context, its actors and child machines, and how the code is split. Part of [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).

### Machine Context

The context holds all frontend state. Key fields:

**From backend (synchronized via state updates):**

- `panes: TmuxPane[]` — All panes from tmux (content, cursor, dimensions, metadata)
- `windows: TmuxWindow[]` — All windows
- `activePaneId`, `activeWindowId` — Current focus
- `totalWidth`, `totalHeight` — tmux grid dimensions
- `keybindings` — Prefix key and all bindings from tmux config
- `defaultShell` — Default shell (bash, zsh, etc.)

**Client-only state:**

- `drag: DragState | null` — Current pane drag operation
- `resize: ResizeState | null` — Current pane resize operation
- `paneGroups: Record<string, PaneGroup>` — Pane group tabs (hidden windows)
- `floatPanes: Record<string, FloatPaneState>` — Floating pane positions
- `commandMode` — Client-side command prompt (`:` mode)
- `paneActivationOrder` — Most-recently-used pane order
- `paneKeyOverrides` — Real-pane-id → placeholder-id mapping (mirrored from TmuxStore so React keys stay stable across optimistic-placeholder → real-pane id swaps)
- `charWidth`, `charHeight`, `cellGap` — the cell grid: `charWidth` is the font advance measured once and snapped to a whole device pixel, `cellGap` the letter-spacing that makes text advance by exactly that width; both are published to CSS as `--cell-w` / `--cell-gap` on the app root (see `utils/cellMetrics.ts`, [RICH-RENDERING.md](RICH-RENDERING-CELL-GRID.md#the-cell-grid-invariant))
- `targetCols`, `targetRows` — Browser viewport in character units
- `containerWidth`, `containerHeight` — Browser container pixel dimensions
- `themeName`, `themeMode`, `availableThemes` — Theme settings
- `enableAnimations` — CSS transitions toggle (disabled on load, enabled after state settles)
- `animationsAllowed` — the config's `@tmuxy-animations` switch (`tmuxy.conf`, read with the appearance options); false strips the pane transitions and the float keyframes for the session, whatever `enableAnimations` settles to
- The pictures a tab shows of itself — the Tab Overview's cards and the strip's hover preview — read the panes through `hooks/useTabStill.ts`, which re-samples once a second. Following the panes live churns a busy tab's thumbnail on every frame of output; freezing them when the picture opens lets it go stale while it is on screen. No machine field holds it: it is what the two components are looking at, not session state
- `cursorBlink` — the config's `@tmuxy-cursor-blink` switch, read with the appearance options and flipped from View > Blinking Cursor; the backend writes the new value to the managed state file so it outlives a tmux restart. It is a permission, not an order: a running application that asked for a steady cursor through DECSCUSR still gets one, and the copy-mode cursor never blinks
- `tabOverviewCols` — the config's `@tmuxy-tab-overview-cols` (default 3, capped at 12 by the backend), read with the appearance options: how many cards each row of the "all tabs" view holds. A phone-width window shows at most 2; the grid scrolls vertically when the rows outgrow the view
- `gestureFlags` — the config's `@tmuxy-gesture-swipe-tabs`, `@tmuxy-gesture-pinch-zoom` and `@tmuxy-gesture-pinch-overview` (all on by default), read with the appearance options. `gestureActor` reads them off the machine as each event arrives and claims nothing for a gesture that is off; the desktop shell is told the slide flag so it leaves those scroll events to the webview
- `gesture` — the trackpad gesture being drawn, owned by the `gestures` state. **Desktop only** (`docs/DESKTOP.md`): the web build runs the machine's no-op gesture actor. On the desktop `gestureActor` takes the slide from the shell (`window.tmuxyGesture`, with the real began/changed/ended phases a page never gets) and the pinch from WebKit's `gesturestart/change/end` (or ctrl+wheel on WebKitGTK), and turns them into `GESTURE_*` events. `GestureStage` writes each step as an inline `transform` on `.pane-layout` (or on the pinched pane) and nudges the cursor overlay: `transform` is not inherited and runs on the compositor, so a step invalidates no terminal styles and re-renders nothing; `PaneLayout` only re-renders when the gesture's shape changes. A slide moves the grid with the tab it pulls in drawn beside it from its real (normally hidden) panes. Releasing it past the mark switches tabs in that same step — the keyboard, the tab strip and tmux never wait for an animation — and because the tab switching in is already drawn where it will rest, the grid is simply put back by that offset and run home (`finishing`), with the tab just left sliding out beside it; released short, it slides back (`cancelling`). Neither ever reverses. What commits is where the slide would land carried on at the speed the fingers had (`swipeCommits`): a quarter of the pane width, capped at a distance a trackpad can cover, so a slow drag short of that settles back — and a flick switches on its speed alone, however short; the finish then takes as long as that distance at that speed (`swipeSettleMs`, 90-320ms). Past either end of the strip the grid gives with rubber-band resistance. The fingers resting on the pad mid-slide is simply no event: the slide ends at the shell's `ended`, never on a timer, and the momentum tail macOS sends after a lift is swallowed by the shell. A pinch in shrinks the grid (opening the "all tabs" view, or unzooming), a pinch out grows the pane under the fingers (zooming it), and a pinch out of the "all tabs" view grows the grid out of the current tab's card and enters that tab. A committed zoom holds the drawing (`handoff`) until `PaneLayout`'s zoom MutationObserver sees the new geometry land and animates on from the held box (`utils/zoomHandoff.ts`)
- Zoom animation — `PaneLayout` animates a pane zooming or unzooming from a MutationObserver on the pane boxes' inline style, not from a render diff: the zoomed flag can land a render after the geometry, so the observer catches the exact mutation, before paint, with the box the pane really had

### Actors

The machine invokes five persistent actors:

**`tmuxActor`** (`tmuxy-ui/src/machines/actors/tmuxActor.ts`) — Bridge to the Rust backend. Receives `SEND_COMMAND`, `INVOKE`, `FETCH_INITIAL_STATE`, `FETCH_THEME_SETTINGS`, etc. from the parent. Sends `TMUX_CONNECTED`, `TMUX_STATE_UPDATE`, `TMUX_ERROR`, `CONNECTION_INFO`, `KEYBINDINGS_RECEIVED`, `TMUX_CLIPBOARD` to the parent.

**`tmuxStoreActor`** (`tmuxy-ui/src/machines/actors/tmuxStoreActor.ts`) — Bridges the client model (`TmuxStore`) into XState. Receives `DISPATCH_COMMAND` (optimistic dispatch) and `RECONCILE_SERVER` (server snapshot reconciliation) from the parent; forwards every model change back as `TMUX_MODEL_UPDATE`.

**`keyboardActor`** (`tmuxy-ui/src/machines/actors/keyboardActor.ts`) — DOM keyboard input handling. Manages prefix mode (waits for next key after prefix), the text-vs-chord classification that decides whether a keydown is sent as literal text or as a tmux key name (dead keys, macOS Option and AltGr all compose characters behind chord-looking flags — see [DATA-FLOW.md](DATA-FLOW.md)), IME composition support (a hidden input in `tmuxy-ui/src/utils/mobileKeyboard.ts` holds browser focus on every device and follows the pane, float or dock holding the keyboard so a composition can start; individual keydowns are suppressed during CJK input and the composed string is committed to the pane where the composition began), the Tab rule (Tab is the terminal's while a pane holds the keyboard; on a chrome control the keyboard reached, such as a header button, a tab strip or the tree's selected row, it walks the page's tab order, while a clicked control hands the focus straight back to the pane; panes are focusable for the pointer but never Tab stops; see `tmuxy-ui/src/utils/chromeTab.ts`), copy mode interception (all keys captured and sent as `COPY_MODE_KEY` when the active pane is in client-side copy mode), root bindings (bypass prefix), and paste chunking (large pastes split into 500-char chunks). Sends `SEND_TMUX_COMMAND`, `KEY_PRESS`, and `COPY_SELECTION` to the parent.

**`sizeActor`** (`tmuxy-ui/src/machines/actors/sizeActor.ts`) — Viewport tracking. Measures monospace font char dimensions on start, listens to window resize (debounced 100ms), observes container with `ResizeObserver`. Sends `SET_CHAR_SIZE`, `SET_TARGET_SIZE`, `SET_CONTAINER_SIZE` to the parent. A sidebar column opens and shuts at once, and its toggle sends the grid its size for the width the column leaves (`selectSettledPaneWidth`) in the same step, so tmux re-tiles once rather than after the container's next measure.

On a phone (`(pointer: coarse), (max-width: 600px)`, or the `phoneLayout` config override a story uses) the size actor sends `SET_PHONE_LAYOUT` and the machine fixes every `SET_TARGET_SIZE` at 80 × 24: the window is never sized to the screen. Instead the cell shrinks until 80 columns span the pane container (`utils/phoneLayout.ts`), and `SET_CHAR_SIZE` carries the grid's own font size, which `App.tsx` scopes to the terminal so the chrome keeps its size. The layout is then the terminal with tmux's line as its 25th row, the key row (`components/KeyRow.tsx`, whose ctrl/alt latch through `utils/keyLatch.ts` for the next key from the row or the phone keyboard), and the sidebar tree below; no tab strip. A phone on a session shared with a desktop client shrinks that client's window to 80 × 24 too, as any smaller client does.

**`serversActor`** (`tmuxy-ui/src/machines/actors/serversActor.ts`) — Polls the sessions tree for the sidebar (runs on web and desktop when the adapter sets `enumeratesSessions`), and every ~15s the git worktree discovery behind the tree's branch badges (`GIT_REPOSITORIES_UPDATED` → `repositories`; see [TMUX.md](TMUX.md) "Sessions tree").

### Child Machines

**`dragMachine`** (`tmuxy-ui/src/machines/drag/dragMachine.ts`) — Pane drag-to-swap. States: `idle` and `dragging`. During drag, finds swap targets based on cursor position and sends a `swap-pane` once the pointer has rested on a pane for a moment (`SWAP_DWELL_MS`), so a pane the pointer only crosses on its way somewhere else stays put. Updates the parent's `drag` context via `DRAG_STATE_UPDATE`. Carried up onto the tab strip the same drag means the pane leaves its tab: over a tab's button it joins that tab (`join-pane`), over the empty space past the last button it becomes a tab of its own (`break-pane`). The strip's boxes are measured once at drag start (`utils/tabStripDrop.ts`) because the machine owns the pointer and the strip sees no events of its own; while the pointer is up there no swap runs, and unlike a swap the move waits for the release, since passing over a tab on the way somewhere else must not rearrange two tabs. Over a pane's header the drag is about pane groups (`utils/groupDrop.ts`): a header is divided into equal shares, one per member, so where the pointer sits names a place in the order by arithmetic over the pane boxes. A member dragged along its own header moves there (`pane-group-move`), an ungrouped pane dropped on another header joins that group at the nearest gap (`pane-group-join`), and a parked member dragged out by its tab leaves the group — beside the pane it is dropped on, to the side the pointer is nearest, or as a tab on the strip (`pane-group-leave`). These wait for the release too, and the header marks where the pane would go.

**`resizeMachine`** (`tmuxy-ui/src/machines/resize/resizeMachine.ts`) — Pane resize via divider dragging. States: `idle` and `resizing`. Tracks pixel delta, converts to character units, sends tmux `resize-pane` commands when delta >= 1 char. Throttles to avoid command spam.

### How the app machine is split

`appMachine.ts` holds the lifecycle (connecting / idle / reconnecting), the actor wiring and the handlers that cut across concerns, including the one command path every tmux command goes through. Everything else is grouped by the context fields it owns: `machines/app/states/<concern>.ts` holds that concern's event handlers (an `on` map spread into the machine), and `machines/app/actions/<concern>.ts` the named actions they refer to. `context.ts` builds the initial context and owns the field-ownership map. Optimistic tmux state is not machine state at all: it lives in the store under `src/domain/store/`.

**One-owner-per-field invariant.** `FIELD_OWNERS` in `context.ts` maps every
`AppMachineContext` field to the concern that owns it (the owner names are the `states/` file names, plus `parent` for the machine itself). The
`tmuxy/state-field-ownership` ESLint rule (in `packages/tmuxy-ui/eslint-rules/`)
reads that map out of `context.ts` itself, so there is one copy, and
enforces it: any `assign({...})` (or `assignCtx({...})`, the same builder
bound to the machine's types in `machines/app/actionTypes.ts`) inside a
`states/<name>.ts` or `actions/<name>.ts` file may only mutate fields owned
by `<name>`.
Cross-cutting handlers that legitimately span states opt out with a
`// cross-cutting: <reason>` comment on the assign.

Action names are prefixed with the owning state (`uiPrefs_applyTheme`,
`layout_selectTab`, etc.) so they don't collide when merged into the
parent's `setup({ actions })` block.

### Domain and infrastructure

The frontend splits along one line: `src/domain/` is pure — branded ids (`ids.ts`), the wire schemas and the decoding into them (`wire.ts`), the client model derived from the wire (`client.ts`), the command vocabulary (`commands.ts`: `TmuxOp` and `toTmuxCommand`, the only code that spells a tmux command), and the store's pure model (`store/`: predict, reconcile, replay). `src/infra/` is everything with an effect, as Effect services and Layers: the `TmuxTransport` service and its four Layers (`transport/`, see [DATA-FLOW.md](DATA-FLOW.md)), the one `ManagedRuntime` the app runs them on (`runtime.ts`), the store that holds the model and sends ops (`store/TmuxStore.ts`), the tracer and the latency tracker. XState machines orchestrate between the two: the actors run effects on the runtime, and machine actions call domain functions.

Failures are one tagged union (`infra/transport/AdapterError.ts`): `TmuxError` when tmux itself refused a command (the server's `kind: "tmux"`), `TransportError` for everything a transport reports otherwise (no monitor, a timeout, a malformed or forbidden request), `ProtocolError` for a payload that does not decode, and `Cancelled`. The tmux actor turns a failure into `TMUX_ERROR { error }`, a display string for the snackbar.
