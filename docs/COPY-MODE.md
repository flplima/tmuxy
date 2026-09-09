# Scrollback: the scroll view and copy mode

Tmuxy renders scrollback **on the client** and scrolls it with the **native browser scroll**. The
frontend fetches a pane's history as structured cells, renders them in a real scrollable container
(`ScrollbackTerminal`), and lets the browser handle wheel/touch/drag scrolling — so scrollback feels
like a native terminal rather than a series of `send-keys -X scroll` round-trips.

There are **two views** over that one machinery, and which one a pane is showing is
`copyModeStates[paneId].mode` (`ScrollbackMode` in `tmux/types.ts`):

| | `scroll` — the native-like view | `copy` — tmux copy mode |
|---|---|---|
| Opened by | wheel or touch scroll up on a pane that is not a full-screen application | `prefix [`, a CLI `copy-mode`, or tmux entering it itself |
| Told to tmux | **nothing** — the pane never enters `in_mode` and the application keeps running | `copy-mode -t <pane>` |
| Cursor | none | block copy cursor, which is also the selection's moving end |
| Selection | the **browser's own**, on `user-select: text` content | cell ranges the client computes (`v`, `V`, `y`) |
| Keys | go to the pane; the first one closes the view | intercepted and resolved as vi motions |
| Closed by | typing, `Escape`, or scrolling back to the bottom | `q` / `Escape` / `y`, or scrolling to the bottom |

They share the record, the loader, the chunk merge and the renderer, so a pane has at most one of
them and the difference is only in cursor, selection, key routing and what tmux is told.

**Selection outside copy mode is the browser's.** Terminal content that is not a mouse-tracking
application carries `terminal-selectable` (`user-select: text`), so dragging, double-clicking and
triple-clicking select text on the live screen and in the scroll view without entering any mode —
and `Cmd+C` copies it. Only copy mode drives selection from the client, because only there is the
selection anchored to a cursor the keyboard moves. Panes whose application tracks the mouse are
deliberately left unselectable: there the drag belongs to the application and is forwarded as SGR.

## Architecture

```
Input (keyboard / mouse / wheel / touch)
    │
    ├─ keyboard ───────────────────────────────────────────────────────────────┐
    │     when the active pane is in copy mode, keyboardActor.ts intercepts      │
    │     keydowns (preventDefault) and sends COPY_MODE_KEY; copyModeKeys.ts     │
    │     (handleCopyModeKey) resolves the vi motion/selection client-side.      │
    │                                                                            ▼
    ├─ wheel / touch / drag ───────────────────────────────┐            tmux (control mode)
    │     usePaneMouse.ts / usePaneTouch.ts scroll the      │            copy-mode, send-keys -X,
    │     ScrollbackTerminal's native scroll container;     │            capture-pane -p -e -S -E
    │     onScroll → COPY_MODE_SCROLL. Mouse drag / double- │                    │
    │     / triple-click → COPY_MODE_* selection events.    │                    │
    │                                                       ▼                    ▼
    └─ appMachine.ts copyMode actions (actions/copyMode.ts) ◄───────── FETCH_SCROLLBACK_CELLS
          own copyModeStates[paneId]: cursor, selection,          (tmuxActor → adapter.invoke
          scrollTop, and the loaded scrollback `lines` map.        'get_scrollback_cells')
                                                       │
                                                       ▼
   ScrollbackTerminal.tsx renders the loaded cells + the client cursor/selection into a tall,
   natively-scrollable <div>; TerminalPane pins the live Terminal to the bottom when NOT in copy mode.
```

When a pane is in **copy mode**, the keyboard actor derives it fresh on every keydown from
`copyModeStates[activePaneId]` (a focused float always takes priority) and routes keys to the client
engine instead of tmux — so switching or closing the pane instantly stops copy-mode routing with no
extra plumbing. A pane in the **scroll view** routes nothing: the keystroke closes the view and
carries on to tmux.

Copy mode is **per-pane**: `TerminalPane` reads `copyModeStates[paneId]` and renders `ScrollbackTerminal`
when present, otherwise the live `Terminal`. State for a pane is pruned when the pane leaves copy mode or
is closed — the `TMUX_STATE_UPDATE` reconciliation in `appMachine.ts` owns that pruning.

## Entry and Exit

**Scroll view — entry and exit:**
- Wheel-up / touch-scroll-up on a pane with history that is **not** on the alternate screen and is
  **not** tracking the mouse — `usePaneMouse` / `usePaneTouch` send `ENTER_SCROLL_MODE`. That gate is
  what keeps the view out of nvim, htop, less and Claude Code: a full-screen application's scroll is
  its own, forwarded as SGR or arrow keys (`scrollUtils.sendScrollLines`).
- The first real keystroke closes it (`keyboardActor` sends `EXIT_SCROLL_MODE`) and the key goes on to
  the pane, so typing while scrolled up lands at the prompt. Modifier-only presses do not, or holding
  Shift to extend a selection would close what you are selecting from. `Escape` closes it and is spent.
- Scrolling back to the bottom with nothing selected closes it (`copyMode_scroll`).
- No `send-keys -X cancel` and no re-entry cooldown on the way out — both belong to a tmux mode this
  view never enters.

**Copy mode — entry and exit:**
- `prefix + [` — the `copy-mode` command is intercepted in `appMachine` and raised as `ENTER_COPY_MODE`
  (the original command still forwards to tmux, which flips `in_mode`).
- A pane reported `in_mode` by tmux (e.g. a CLI `copy-mode`, a custom binding) — the `TMUX_STATE_UPDATE`
  reconciliation initializes a client copy-mode state and fetches its full history.
- `q` / `Escape` / `y` — handled by tmux's `copy-mode-vi` bindings; the pane leaves `in_mode` and the
  reconciliation drops the client state.
- Scrolling back to the bottom of history with no active selection — `copyMode_scroll` auto-exits.
  A selection holds the view open — copy mode's own, or the browser's in the scroll view, which
  the scroll event reports (`nativeSelection`) since only the component can see it.
- A 2-second re-entry cooldown (`COPY_MODE_REENTRY_COOLDOWN`) prevents a stale `in_mode` flag from
  immediately re-opening copy mode after an exit.

The mouse never opens copy mode. A wheel gesture opening a mode with a cursor and vi keys is what
this split exists to undo.

## Scrollback loading

History is loaded lazily as structured cells, never as a client-maintained scrollback buffer of live
output. On entry the client fetches the full backlog; as the user scrolls, `getNeededChunk` requests
200-line chunks around the viewport and `mergeScrollbackChunk` merges them into the `lines` map
(tracked by `loadedRanges`). Rows that exist but aren't loaded yet render as dim placeholders.

The fetch is a single adapter call — `adapter.invoke('get_scrollback_cells', { paneId, start, end })` —
implemented per transport:

- **HTTP/SSE server** — `ClientCommand::GetScrollbackCells` runs `capture-pane -p -e -S start -E end`
  and parses it with `parse_scrollback_to_cells` (`tmuxy-server/src/sse.rs`, `tmuxy-core`).
- **Tauri desktop** — the `get_scrollback_cells` command mirrors the same capture + parse
  (`tmuxy-tauri-app/src/commands.rs`).
- **Fully client-side (v86)** — there is no server, so `V86Engine.captureScrollback` runs the same
  `capture-pane` over the in-browser control connection (bracketed by unique markers so its lines can
  be picked out of the stream) and hands the raw text to the core's `parse_scrollback` (a wasm export
  of `parse_scrollback_to_cells`), reusing the identical ANSI parser instead of a JS reimplementation.

## Keyboard

Copy-mode vi keybindings are reimplemented client-side in `copyModeKeys.ts` (`handleCopyModeKey`). While
a pane is in copy mode, `keyboardActor.ts` calls `preventDefault()` on every keydown and dispatches
`COPY_MODE_KEY`; the `copyMode_key` action resolves it to cursor motion, selection, page/word/line
motions, yank, or exit against the pane's `CopyModeState`. Supported keys include `h`/`j`/`k`/`l` (+
arrows), `0`/`$`, `w`/`b`/`e`, `H`/`M`/`L`, `gg`/`G`, `Ctrl-u`/`Ctrl-d`/`Ctrl-b`/`Ctrl-f`, `Space`/`v`
(char select), `V` (line select), `y` (yank), and `q`/`Escape` (exit). Yank and `Ctrl/Cmd-C` copy the
extracted selection to the system clipboard via the keyboard actor's native `copy` event.

## Mouse and selection

**In copy mode**, `usePaneMouse` drives the client selection:

- **Drag** — starts a char selection at the drag origin and extends it as the cursor moves
  (`COPY_MODE_SELECTION_START` / `COPY_MODE_CURSOR_MOVE`). Auto-scrolls when dragging past an edge.
- **Double-click** — selects the word under the cursor (`COPY_MODE_WORD_SELECT`).
- **Triple-click** — selects the whole logical line (`COPY_MODE_LINE_SELECT`), expanded across wrapped rows.

**Everywhere else** the hook deliberately does nothing on those gestures and prevents no default, so
the browser selects — which also means double-click word boundaries come from the engine rather than
a cell heuristic. Right-click reads that selection (`utils/nativeSelection.ts`), picking the word
under the pointer first when nothing is selected; a right-click does not move browser focus to the
hidden keyboard input, which would collapse the selection it is about to read. While the menu is up
the selection is pinned (`SelectionContextMenu`): the menu takes focus on open and each item on
hover, and WebKit collapses the document selection whenever focus moves — so whatever collapses it,
it is put back until the menu closes.

A browser selection lives in DOM nodes, so the scroll view keeps them: `ScrollbackTerminal` mounts
each row as its own absolutely positioned node, repaints a row only when its content changes (never
because the window moved), and keeps every row a selection spans mounted while it lasts — so the
selection survives scrolling, in either direction and all the way to the bottom, and reads back
whole, since selection text is document order.

**Wheel / touch** scroll the native container while a view is open; `onScroll` reports the new top row
via `COPY_MODE_SCROLL`. Mouse-tracking applications (`mouse_any_flag`, e.g. nvim/htop) receive
forwarded SGR mouse sequences instead — that path is unchanged.

## Clipboard

Selected text is extracted client-side (`extractSelectedText`, which joins wrapped rows into logical
lines). Keyboard yank (`y`/`Enter`) and `Ctrl/Cmd-C` set the extracted text on the keyboard actor's
native `copy` event (`document.execCommand('copy')` → `clipboardData`). The right-click **Copy** action
writes it via `navigator.clipboard.writeText`; the selection context menu's other item, **Send keys**,
types the selection into the pane. Either closes the view.

## Key files

| File | Responsibility |
|------|----------------|
| `packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx` | Virtual-scrolling renderer for loaded scrollback + client cursor/selection |
| `packages/tmuxy-ui/src/components/TerminalPane.tsx` | Chooses `ScrollbackTerminal` vs live `Terminal`; owns the native scroll container and `onScroll` |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode.ts` | XState actions for both views: enter/exit, cursor/selection, scroll, chunk merge, prefetch |
| `packages/tmuxy-ui/src/utils/nativeSelection.ts` | Reading the browser's selection and selecting the word under a point |
| `packages/tmuxy-ui/src/machines/app/states/copyMode.ts` | Wires `COPY_MODE_*` events to their actions (idle-only) |
| `packages/tmuxy-ui/src/machines/actors/keyboardActor.ts` | Intercepts keydowns in copy mode → `COPY_MODE_KEY` / `COPY_SELECTION`; native clipboard `copy` handler |
| `packages/tmuxy-ui/src/utils/copyModeKeys.ts` | Pure vi-key handler (`handleCopyModeKey`): motions, selection, page/word/line, yank, exit |
| `packages/tmuxy-ui/src/utils/copyMode.ts` | Pure helpers: scrollback merge, needed-chunk detection, selected-text extraction |
| `packages/tmuxy-ui/src/hooks/usePaneMouse.ts` / `usePaneTouch.ts` | Mouse/touch → copy-mode enter, selection, and native scroll |
| `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` | `FETCH_SCROLLBACK_CELLS` → `adapter.invoke('get_scrollback_cells')` → `COPY_MODE_CHUNK_LOADED` |
| `packages/tmuxy-core/src/lib.rs` | `parse_scrollback_to_cells` (shared by server, Tauri, and the wasm core) |
| `packages/tmuxy-ui/src/tmux/v86/V86Engine.ts` | `captureScrollback` (marker-bracketed capture) + `parseScrollback` for the in-browser deployment |

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — the `copyMode` parallel state and `copyModeStates` context
- [NON-GOALS.md](NON-GOALS.md) — why client scrollback rendering is the one scrollback-like feature we implement
- [DATA-FLOW.md](DATA-FLOW.md) — the SSE/HTTP/Tauri/v86 transports the scrollback fetch rides on
