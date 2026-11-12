# Scrollback: the scroll view and copy mode

Tmuxy renders scrollback **on the client** and scrolls it with the **native browser scroll**. The
frontend fetches a pane's history as structured cells, renders them in a real scrollable container
(`ScrollbackTerminal`), and lets the browser handle wheel/touch/drag scrolling — so scrollback feels
like a native terminal rather than a series of `send-keys -X scroll` round-trips.

There are **two views** over that one machinery, and which one a pane is showing is
`copyModeStates[paneId].mode` (`ScrollbackMode` in `domain/copyMode.ts`):

|  | `scroll` — the native-like view | `copy` — tmux copy mode |
| --- | --- | --- |
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
Where the browser owns the drag, the pane does not take the hidden keyboard input's focus on the
press — focusing an input collapses the page's selection — and the keyboard actor hands focus to the
input on the release instead, only if nothing was selected. While the browser holds a selection on
the live screen, the screen holds still (`components/terminal/useHeldWhileSelected.ts`): the live
grid reuses row nodes by screen index, so output that scrolls would slide other text under the
highlight. The program keeps running; the pane catches up the moment the selection collapses. The
scroll view needs none of this — its rows are keyed by absolute line.

**Select all is the client's selection, in either view.** `Cmd+A` (`Ctrl+Shift+A` off macOS) selects a
pane's whole scrollback — opening the scroll view on a pane that has no view yet, since there is
nothing else to hold a selection over history that is not on screen. On a pane whose application owns the screen (alternate screen, or tmux's own mode) it does nothing —
the same gate the wheel uses, since there is no scrollback behind such a screen. It is a _client_
selection (a line selection from the first row of history to the last row on screen), not the
browser's: most of
the history has no DOM node to select, so the browser could not express it and the copy could not
read it. `Cmd+C` (`Ctrl+Shift+C` off macOS — plain `Ctrl+C` stays the interrupt) copies it from the
loaded rows and closes the view with the usual blink, as a yank does. Because every selected row has
to be backed by loaded cells, select-all keeps asking for the next unloaded gap
(`firstUnloadedGap`) until there are none — lazy loading leaves holes on purpose, and a hole under a
select-all is a hole in the middle of the copied text.

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
is closed — `reconcilePaneMode` (`machines/app/actions/copyMode/scrollback.ts`), run from the model update
(`machines/app/actions/layout/modelUpdate.ts`) on every state the server sends, owns that pruning.

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

- `prefix + [` — the `copy-mode` command is intercepted in `machines/app/dispatch.ts` and raised as `ENTER_COPY_MODE`
  (the original command still forwards to tmux, which flips `in_mode`).
- A pane reported `in_mode` by tmux (e.g. a CLI `copy-mode`, a custom binding) — `reconcilePaneMode`
  initializes a client copy-mode state and fetches its full history.
- `q` / `Escape` / `y` — handled by tmux's `copy-mode-vi` bindings; the pane leaves `in_mode` and
  `reconcilePaneMode` drops the client state.
- Scrolling back to the bottom of history with no active selection — `copyMode_scroll` auto-exits.
  A selection holds the view open — copy mode's own, or the browser's in the scroll view, which
  the scroll event reports (`nativeSelection`) since only the component can see it.
- A 2-second re-entry cooldown (`COPY_MODE_REENTRY_COOLDOWN`) prevents a stale `in_mode` flag from
  immediately re-opening copy mode after an exit.

No mouse gesture opens copy mode: a wheel gesture opening a mode with a cursor and vi keys is what
this split exists to undo. The one pointer path in is a phone's touch-hold (`components/terminal/usePaneTouch.ts`), which
selects the word under the finger and needs copy mode's own selection to do it.

## Scrollback loading

Row indices are absolute: a row's index is `history_size + <tmux offset>`. A view can open before tmux
has reported the pane's real `history_size` (it starts near zero), so every response carries the size
it was answered with and rows already merged are re-keyed by the difference
(`shiftScrollbackRows`) before the new chunk lands; otherwise the screen rows would sit on top of
the oldest history.

History is loaded lazily as structured cells, never as a client-maintained scrollback buffer of live
output. On entry the client fetches the newest 500 rows of history and the screen
(`FIRST_HISTORY_ROWS`), which a first wheel scroll shows at once however long the history; each
answer then asks for the next 2,000 rows above what is in (`HISTORY_CHUNK_ROWS`), newest first,
until the oldest row is loaded. As the user scrolls, `getNeededChunk` requests 200-line chunks
around the viewport and `mergeScrollbackChunk` merges them into the `lines` map (tracked by
`loadedRanges`). Rows that exist but aren't loaded yet render as dim placeholders.

The fetch is a single transport call — `call('get_scrollback_cells', { paneId, start, end })`:

- **HTTP/SSE server and Tauri desktop** — both forward `ClientCommand::GetScrollbackCells` to
  `tmuxy_core::host::handle` (`tmuxy-core/src/host/command.rs`), whose `scrollback_cells`
  (`host/requests.rs`) runs one in-band query — the pane's width and `history_size` and a
  `capture-pane -p -e -S start -E end` in the same command list, so they describe the same
  moment — and parses the text with `parse_scrollback_to_cells`.
- **Fully client-side (v86, CheerpX)** — there is no server, so `GuestEngine.captureScrollback` runs the same
  `capture-pane` over the in-browser control connection (a reply the wasm core correlates, as the
  native monitor does) and hands the raw text to the core's `parse_scrollback` (a wasm export
  of `parse_scrollback_to_cells`), reusing the identical ANSI parser instead of a JS reimplementation.

## Keyboard

Copy-mode vi keybindings are reimplemented client-side in `domain/copyModeKeys.ts` (`handleCopyModeKey`). While
a pane is in copy mode, `machines/actors/keyboardActor.ts` calls `preventDefault()` on every keydown and dispatches
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
- **Release** of a drag copies the selection to the clipboard and leaves copy mode
  (`COPY_MODE_MOUSE_COPY`), as tmux's `MouseDragEnd1Pane → copy-pipe-and-cancel` does — the default
  config binds exactly that, so a native tmux client behaves the same. tmux leaves its mode at once;
  the client's view stays for the copy blink and then closes (`COPY_MODE_COPIED_EXIT`).

**Everywhere else** the hook deliberately does nothing on those gestures and prevents no default, so
the browser selects — which also means double-click word boundaries come from the engine rather than
a cell heuristic. Right-click reads that selection (`infra/dom/nativeSelection.ts`) and opens the
selection's menu over it; with nothing selected it opens the pane's own menu instead, the one its
header opens (`PaneContextMenu`). A right-click does not move browser focus to the hidden keyboard
input, which would collapse the selection it is about to read. While the menu is up
the selection is pinned (`SelectionContextMenu`): the menu takes focus on open and each item on
hover, and WebKit collapses the document selection whenever focus moves — so whatever collapses it,
it is put back until the menu closes.

A browser selection lives in DOM nodes, so the scroll view keeps them: `ScrollbackTerminal` mounts
each row as its own absolutely positioned node, repaints a row only when its content changes (never
because the window moved), and keeps every row a selection spans mounted while it lasts — so the
selection survives scrolling, in either direction and all the way to the bottom, and reads back
whole, since selection text is document order.

**Wheel / touch** scroll the native container while a view is open, a whole row at a time
(`takeWholeRows` / `scrollByRows` in `components/terminal/scrollUtils.ts`) — the sub-row part of a trackpad delta is
carried into the next event rather than painted, so the container always rests on a row boundary and
the top row is never half drawn. That matches the rest of the pane: copy mode moves a cursor that
lives on a row, and a full-screen application is sent rows. `onScroll` reports the new top row
via `COPY_MODE_SCROLL`. Mouse-tracking applications (`mouse_any_flag`, e.g. nvim/htop) receive
forwarded SGR mouse sequences instead — that path is unchanged.

A **swipe that opens a view** outlives the DOM it started on, so two rules hold: the live screen
stays mounted (hidden) behind an open view rather than being replaced, because a touch is dispatched
to the node it started on for its whole life and a node out of the document passes it to no listener;
and `ENTER_SCROLL_MODE` on an already-open view scrolls it further instead of rebuilding it at the
bottom, because each further move still asks to open one until React has re-rendered.

## Clipboard

**Copy on select**, as the Claude Code TUI does it: the mouse release that ends a browser selection
over terminal text (a drag, a double or triple click, on the live screen or in the scroll view) puts
the text on the clipboard at once and raises an info notification saying how many
characters went. The selection stays on screen, and the screen holds still under it. The next key —
`Ctrl+C`, `Cmd+C`, a letter — clears the selection and is processed as typed: `Ctrl+C` interrupts
the shell, a letter goes to the pane, `Cmd+C` copies the same text once more before the highlight
goes. A modifier on its own leaves it. The same text still selected on a later release is not copied
twice; once the selection has gone, selecting it again copies again. The keyboard actor's clipboard
module owns this (`machines/actors/keyboard/imeAndClipboard.ts`); the touch hold on a phone keeps
its own Copy/Cancel bar.

Selected text is extracted client-side (`extractSelectedText`, which joins wrapped rows into logical
lines). A copy by key or menu blinks the copied text in place (`infra/dom/copyFlash.ts`); copy on select
does not. Copy mode paints its own
selection, so its copy sets `copiedAt` on the view, the scrollback marks itself `data-copied`, and the
view closes when the blink is over — keyboard yank, `Ctrl/Cmd-C` and a drag release alike. A browser
selection is covered by fixed boxes laid over its rectangles instead, on `Cmd+C` and on the
right-click **Copy**. With animations off the highlight holds steady for the same time. Keyboard yank (`y`/`Enter`) and `Ctrl/Cmd-C` set the extracted text on the keyboard actor's
native `copy` event (`document.execCommand('copy')` → `clipboardData`). The right-click **Copy** action
writes it via `navigator.clipboard.writeText`; the selection context menu's other item, **Send keys**,
types the selection into the pane. Either closes the view.

## Key files

| File | Responsibility |
| --- | --- |
| `packages/tmuxy-ui/src/components/terminal/ScrollbackTerminal.tsx` | Virtual-scrolling renderer for loaded scrollback + client cursor/selection |
| `packages/tmuxy-ui/src/components/terminal/TerminalPane.tsx` | Chooses `ScrollbackTerminal` vs live `Terminal`; owns the native scroll container and `onScroll` |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode.ts` | XState actions for both views: enter/exit, cursor/selection, scroll, key handling |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode/scrollback.ts` | Building a view's state, history fetch and chunk merge, `reconcilePaneMode` (open/prune against tmux's `in_mode`), leaving after a copy |
| `packages/tmuxy-ui/src/infra/dom/nativeSelection.ts` | Reading the browser's selection and selecting the word under a point |
| `packages/tmuxy-ui/src/machines/app/states/copyMode.ts` | Wires `COPY_MODE_*` events to their actions (idle-only) |
| `packages/tmuxy-ui/src/machines/actors/keyboardActor.ts` | The keyboard actor; its copy-mode and clipboard work is in the two modules below |
| `packages/tmuxy-ui/src/machines/actors/keyboard/modalAndCopyKeys.ts` | Classifies keydowns in copy mode, the scroll view and the ask overlay → `COPY_MODE_KEY` / `COPY_SELECTION`, and the copy a browser allows only inside the key's own event |
| `packages/tmuxy-ui/src/machines/actors/keyboard/imeAndClipboard.ts` | Copy on select, the native `copy` event, IME composition |
| `packages/tmuxy-ui/src/domain/copyModeKeys.ts` | Pure vi-key handler (`handleCopyModeKey`): motions, selection, page/word/line, yank, exit |
| `packages/tmuxy-ui/src/domain/copyMode.ts` | The copy-mode state, and the pure helpers on it: scrollback merge, row re-keying, gap detection, needed-chunk detection, selected-text extraction |
| `packages/tmuxy-ui/src/components/terminal/usePaneMouse.ts` / `components/terminal/usePaneTouch.ts` | Mouse/touch → copy-mode enter, selection, and native scroll |
| `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` | `FETCH_SCROLLBACK_CELLS` → `call('get_scrollback_cells')` → `COPY_MODE_CHUNK_LOADED` |
| `packages/tmuxy-core/src/host/requests.rs` | `scrollback_cells`: the in-band capture both hosts answer `get_scrollback_cells` with |
| `packages/tmuxy-core/src/lib.rs` | `parse_scrollback_to_cells` (shared by the host and the wasm core) |
| `packages/tmuxy-ui/src/infra/transport/drivers/guest/GuestEngine.ts` | `captureScrollback` (marker-bracketed capture) + `parseScrollback` for the in-browser deployment |

## Related

- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — the `copyMode` slice and `copyModeStates` context
- [NON-GOALS.md](NON-GOALS.md) — why client scrollback rendering is the one scrollback-like feature we implement
- [DATA-FLOW.md](DATA-FLOW.md) — the SSE/HTTP/Tauri/v86 transports the scrollback fetch rides on
