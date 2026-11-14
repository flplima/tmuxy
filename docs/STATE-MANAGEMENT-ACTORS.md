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

**Client-only state:**

- `drag: DragState | null` — Current pane drag operation
- `resize: ResizeState | null` — Current pane resize operation
- `paneGroups: Record<string, PaneGroup>` — Pane group tabs (hidden windows)
- `floatPanes: Record<string, FloatPaneState>` — Floating pane positions
- `commandMode` — Client-side command prompt (`:` mode)
- `paneKeyOverrides` — Real-pane-id → placeholder-id mapping (mirrored from TmuxStore so React keys stay stable across optimistic-placeholder → real-pane id swaps)
- `charWidth`, `charHeight`, `cellGap` — the cell grid: `charWidth` is the font advance measured once and snapped to a whole device pixel, `cellGap` the letter-spacing that makes text advance by exactly that width; both are published to CSS as `--cell-w` / `--cell-gap` on the app root (see `infra/dom/cellMetrics.ts`, [RICH-RENDERING.md](RICH-RENDERING-CELL-GRID.md#the-cell-grid-invariant))
- `measuredCell` — the cell the size actor measured (or cut for the phone) before any fit; `charWidth`/`charHeight`/`cellGap`/`gridFontSize` are the grid's cell fitted from it (`fittedGridCell`), and the sidebar columns and `targetCols`/`targetRows` are measured in it
- `sizePolicy` — the config's `@tmuxy-size` (`smallest`, `largest`, `latest` or a fixed `COLSxROWS`), read with the appearance options. Every mode but `smallest` fits the grid's cell to the window tmux was given; a fixed one is also what `targetCols`/`targetRows` ask for
- `targetCols`, `targetRows` — Browser viewport in character units
- `containerWidth`, `containerHeight` — Browser container pixel dimensions
- `themeName`, `themeMode`, `availableThemes` — Theme settings
- `enableAnimations` — CSS transitions toggle (disabled on load, enabled after state settles)
- `animationsAllowed` — the config's `@tmuxy-animations` switch (`tmuxy.conf`, read with the appearance options); false strips the pane transitions and the float keyframes for the session, whatever `enableAnimations` settles to
- The pictures a tab shows of itself — the Tab Overview's cards and the strip's hover preview — read the panes through `components/useTabStill.ts`, which re-samples once a second. Following the panes live churns a busy tab's thumbnail on every frame of output; freezing them when the picture opens lets it go stale while it is on screen. No machine field holds it: it is what the two components are looking at, not session state
- `cursorBlink` — the config's `@tmuxy-cursor-blink` switch, read with the appearance options and flipped from View > Blinking Cursor; the backend writes the new value to the managed state file so it outlives a tmux restart. It is a permission, not an order: a running application that asked for a steady cursor through DECSCUSR still gets one, and the copy-mode cursor never blinks
- `transparency` — the config's `@tmuxy-transparency` switch, read with the appearance options and flipped from View > Enable Window Transparency (macOS desktop only); the backend writes it to the managed state file and pushes the theme settings straight back, so the surfaces repaint opaque (`applyAppearance`) as every window's blur is cleared
- `tabOverviewCols` — the config's `@tmuxy-tab-overview-cols` (default 3, capped at 12 by the backend), read with the appearance options: how many cards each row of the "all tabs" view holds. A phone-width window shows at most 2; the grid scrolls vertically when the rows outgrow the view
- `gestureFlags` — the config's `@tmuxy-gesture-swipe-tabs`, `@tmuxy-gesture-pinch-zoom` and `@tmuxy-gesture-pinch-overview` (all on by default), read with the appearance options. `gestureActor` reads them off the machine as each event arrives and claims nothing for a gesture that is off; the desktop shell is told the slide flag so it leaves those scroll events to the webview
- `gesture` — the trackpad gesture being drawn, owned by the `gestures` state. **Desktop only**: the web build runs a no-op gesture actor, while on the desktop `gestureActor` turns the shell's slide phases and WebKit's pinch into `GESTURE_*` events that `GestureStage` draws as a compositor-only `transform`. What commits, what cancels and how a zoom is handed off are [DESKTOP.md](DESKTOP.md) § Trackpad gestures.
- Zoom animation — `PaneLayout` animates a pane zooming or unzooming from a MutationObserver on the pane boxes' inline style, not from a render diff: the zoomed flag can land a render after the geometry, so the observer catches the exact mutation, before paint, with the box the pane really had

### Actors

The machine invokes seven persistent actors (`appMachine.ts`, its `invoke` list) and the two child machines of the next section:

**`tmuxActor`** (`tmuxy-ui/src/machines/actors/tmuxActor.ts`) — Bridge to the backend. Receives `SEND_OP`, `INVOKE`, `FETCH_*` and the like from the parent. Sends `TMUX_CONNECTED`, `TMUX_STATE_UPDATE`, `TMUX_ERROR`, `CONNECTION_INFO`, `KEYBINDINGS_RECEIVED`, `TMUX_CLIPBOARD` to the parent.

**`tmuxStoreActor`** (`tmuxy-ui/src/machines/actors/tmuxStoreActor.ts`) — Bridges the client model (`TmuxStore`) into XState. Receives `STORE_DISPATCH` (a routed op, sent only by `toStore` in `machines/app/dispatch.ts`), `RECONCILE_SERVER` (a snapshot), `CLEAR` and `SET_DEFAULT_SHELL`; forwards every model change back as `TMUX_MODEL_UPDATE`.

**`keyboardActor`** (`tmuxy-ui/src/machines/actors/keyboardActor.ts`) — DOM keyboard input handling. Manages prefix mode, the text-vs-chord classification that decides whether a keydown is sent as literal text or as a tmux key name (dead keys, macOS Option and AltGr all compose characters behind chord-looking flags — see [DATA-FLOW.md](DATA-FLOW.md)), IME composition support (a hidden input in `tmuxy-ui/src/infra/dom/mobileKeyboard.ts` holds browser focus on every device and follows the pane, float or dock holding the keyboard so a composition can start; individual keydowns are suppressed during CJK input and the composed string is committed to the pane where the composition began), the Tab rule (Tab is the terminal's while a pane holds the keyboard; on a chrome control the keyboard reached, such as a header button, a tab strip or the tree's selected row, it walks the page's tab order, while a clicked control hands the focus straight back to the pane; panes are focusable for the pointer but never Tab stops; see `tmuxy-ui/src/infra/dom/chromeTab.ts`), copy mode interception (all keys captured and sent as `COPY_MODE_KEY` when the active pane is in client-side copy mode), root bindings (bypass prefix), and paste (one `PasteText` op). Sends keys as `DISPATCH_OP` (`SendText`/`SendKeys`, batched by the lane), bindings as `SEND_TMUX_COMMAND`, and `KEY_PRESS`, `COPY_SELECTION` to the parent. It reads the machine only through one selector's view (`selectKeyContext`): who holds the keyboard (`keyboardOwner`), the target, the bindings. A key becomes its slice's event (`ASK_KEY`, `COPY_MODE_KEY`) and the slice decides.

**`sizeActor`** (`tmuxy-ui/src/machines/actors/sizeActor.ts`) — Viewport tracking. Measures the font's cell on start and watches the window and the container (`ResizeObserver`), both debounced 100ms: the container's first measure is sent at once, since the state is fetched at it, and a container on the move asks tmux for the size it comes to rest at. Sends `SET_CHAR_SIZE`, `SET_TARGET_SIZE`, `SET_CONTAINER_SIZE` to the parent. A sidebar column opens and shuts at once, and its toggle sends the grid its size for the width the column leaves (`selectSettledPaneWidth`) in the same step, so tmux re-tiles once rather than after the container's next measure.

On a phone (`(pointer: coarse), (max-width: 600px)`, or the `phoneLayout` config override a story uses) the size actor sends `SET_PHONE_LAYOUT`, the window is fixed at 80 × 24 and the cell shrinks to fit it: the phone layout, its keys, its bar, its bottom view, held sideways, and what a finger does, are [PHONE.md](PHONE.md).

**`linkModifierActor`** (`tmuxy-ui/src/machines/actors/linkModifierActor.ts`) — Tracks whether the platform's open-link modifier is held (Cmd on macOS, Ctrl elsewhere, read off every key and pointer event rather than from Meta presses, so a key released outside the window is recovered) and reflects it as a class on `<body>`. Auto-detected URLs are text until the class reveals and arms them; OSC 8 hyperlinks never depend on it. A body class rather than context: the affordance flips for every pane at once, and threading it through React would re-render the whole terminal tree on each press.

**`gestureActor`** (`tmuxy-ui/src/machines/gestures/gestureActor.ts`) — Desktop only; the web build invokes a no-op in its place. Takes the trackpad slide from the native shell through `window.tmuxyGesture` (the real began/changed/ended phases a page never gets) and the pinch from WebKit's `gesturestart/change/end` (ctrl+wheel on WebKitGTK), reads `gestureFlags` off the machine to claim nothing for a gesture the config turns off, and sends `GESTURE_*` events to the parent. See [DESKTOP.md](DESKTOP.md).

**`serversActor`** (`tmuxy-ui/src/machines/actors/serversActor.ts`) — Polls the sessions tree while it is on screen and the tab is visible (`selectTreeVisible`, `document.hidden`; runs on web and desktop when the adapter sets `enumeratesSessions`), and every ~15s (and on its first listing) the git worktree discovery behind the tree's branch badges (`GIT_REPOSITORIES_UPDATED` → `repositories`; see [TMUX.md](TMUX.md) "Sessions tree").

### Closing a busy pane asks first

A close that would end a pane saying `working` or `needs-input` (`@tmuxy-pane-state`) is held by the client's dispatcher (`machines/app/dispatch.ts`) for a confirmation that names the pane's program: Enter closes, Escape keeps, and no key reaches the pane meanwhile. `set -g @tmuxy-confirm-close off` closes at once.

What is asked about is what the client can read (`domain/closeGuard.ts`): a pane's ✕, the menus, a tab's close, and a `kill-pane`, `kill-window`, `kill-session`, `kill-server` or `respawn-… -k` from a binding or the command prompt, alone or in a command list. `-a` counts every other pane or tab; a target the client cannot resolve (an index, a name) counts every pane. Not asked about: a close tmux runs without the client (`tmuxy pane kill` in a shell, another client), a kill wrapped in `run-shell`, `if-shell` or `confirm-before`, and a verb shortened to a prefix (`kill-p`).

### Child Machines

**`dragMachine`** (`tmuxy-ui/src/machines/drag/dragMachine.ts`) — Pane drag-to-swap. States: `idle` and `dragging`. During drag, finds swap targets based on cursor position and sends a `swap-pane` once the pointer has rested on a pane for a moment (`SWAP_DWELL_MS`), so a pane the pointer only crosses on its way somewhere else stays put. Updates the parent's `drag` context via `DRAG_STATE_UPDATE`. Carried up onto the tab strip the same drag means the pane leaves its tab: over a tab's button it joins that tab (`join-pane`), over the empty space past the last button it becomes a tab of its own (`break-pane`). The strip's boxes are measured once at drag start (`machines/drag/tabStripDrop.ts`) because the machine owns the pointer and the strip sees no events of its own; while the pointer is up there no swap runs, and unlike a swap the move waits for the release, since passing over a tab on the way somewhere else must not rearrange two tabs. Over a pane's header the drag is about pane groups (`machines/drag/groupDrop.ts`): a header is divided into equal shares, one per member, so where the pointer sits names a place in the order by arithmetic over the pane boxes. A member dragged along its own header moves there (`pane-group move`), an ungrouped pane dropped on another header joins that group at the nearest gap (`pane-group join`), and a parked member dragged out by its tab leaves the group — beside the pane it is dropped on, to the side the pointer is nearest, or as a tab on the strip (`pane-group leave`). These wait for the release too, and the header marks where the pane would go.

**`resizeMachine`** (`tmuxy-ui/src/machines/resize/resizeMachine.ts`) — Pane resize via divider dragging. States: `idle` and `resizing`. Tracks pixel delta, converts to character units, sends tmux `resize-pane` commands when delta >= 1 char. Throttles to avoid command spam.

### How the app machine is split

`appMachine.ts` holds the lifecycle (connecting / idle / reconnecting / detached / disconnected) and the actor wiring; `dispatch.ts` is the one command path every tmux command goes through. Everything else is grouped by the context fields it owns: `machines/app/states/<concern>.ts` holds that concern's event handlers (an `on` map spread into the machine), and `machines/app/actions/<concern>.ts` the named actions they refer to, helpers in `actions/<concern>/`. `connection` owns the stream and what the server reports, `viewport` the cell and the size this client asks for. `context.ts` builds the initial context and owns the field-ownership map. Optimistic tmux state is not machine state at all: it lives in the store under `src/domain/store/`.

**One-owner-per-field invariant.** `FIELD_OWNERS` in `context.ts` maps every field to its slice; the `tmuxy/state-field-ownership` ESLint rule (`packages/tmuxy-ui/eslint-rules/`) reads it and holds every file in `machines/app/` to it: a slice's `assign`/`assignCtx` writes only its fields, other files none, and a cross-slice write says why (`// cross-cutting: <reason>`). Action names carry their slice (`layout_selectTab`).

### Domain and infrastructure

The frontend splits along one line: `domain/` is pure — branded ids (`ids.ts`), the wire schemas and the decoding into them (`wire.ts`), the client model derived from the wire (`client.ts`), the command vocabulary (`commands.ts`: `TmuxOp` and `toTmuxCommand`, the only code that spells a tmux command), every command a backend takes with its argument and answer schemas (`backendCalls.ts`), and the store's pure model (`domain/store/`: predict, reconcile, replay). `infra/` is everything with an effect, as Effect services and Layers: the `TmuxTransport` service and its three Layers (`infra/transport/layers.ts`: HTTP/SSE, Tauri IPC and the guest, which the demo and the v86 stories share, see [DATA-FLOW.md](DATA-FLOW.md)) — the service owns the one serial lane every op and call takes and the keystroke batching on it (`commandLane.ts`), and the drivers under it only move calls and answers — the one `ManagedRuntime` the app runs them on (`runtime.ts`), the store that holds the model and sends ops (`infra/store/TmuxStore.ts`), the tracer and the latency tracker. XState machines orchestrate between the two: the actors run effects on the runtime, and machine actions call domain functions.

Failures are one tagged union (`infra/transport/AdapterError.ts`): `TmuxError` when tmux itself refused a command (the server's `kind: "tmux"`), `TransportError` for everything a transport reports otherwise (no monitor, a timeout, a malformed or forbidden request), and `ProtocolError` for a payload that does not decode. The tmux actor turns a failure into `TMUX_ERROR { error }`, a display string for the snackbar.
