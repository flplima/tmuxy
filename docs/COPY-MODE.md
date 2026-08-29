# Copy Mode

Tmuxy renders scrollback **on the client** and scrolls it with the **native browser scroll**. When a
pane enters copy mode the frontend fetches its history as structured cells, renders them in a real
scrollable container (`ScrollbackTerminal`), and lets the browser handle wheel/touch/drag scrolling —
so scrollback feels like a native terminal rather than a series of `send-keys -X scroll` round-trips.

tmux's own `copy-mode` is still entered (to set the `in_mode` flag and, for keyboard users, to run its
`copy-mode-vi` table), but tmux's scrolled viewport is not what the UI draws — the client owns the
scrollback rendering, the scroll position, and mouse selection.

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

When a pane is in copy mode, the keyboard actor derives it fresh on every keydown from
`copyModeStates[activePaneId]` (a focused float always takes priority) and routes keys to the client
engine instead of tmux — so switching or closing the pane instantly stops copy-mode routing with no
extra plumbing.

Copy mode is **per-pane**: `TerminalPane` reads `copyModeStates[paneId]` and renders `ScrollbackTerminal`
when present, otherwise the live `Terminal`. State for a pane is pruned when the pane leaves copy mode or
is closed — the `TMUX_STATE_UPDATE` reconciliation in `appMachine.ts` owns that pruning.

## Entry and Exit

**Entry:**
- `prefix + [` — the `copy-mode` command is intercepted in `appMachine` and raised as `ENTER_COPY_MODE`
  (the original command still forwards to tmux, which flips `in_mode`).
- Wheel-up / touch-scroll-up in a normal shell — `usePaneMouse` / `usePaneTouch` raise `ENTER_COPY_MODE`.
- Right-click over content — the selection context menu auto-enters copy mode to select a word.
- A pane reported `in_mode` by tmux (e.g. a CLI `copy-mode`, a custom binding) — the `TMUX_STATE_UPDATE`
  reconciliation initializes a client copy-mode state and fetches its full history.

**Exit:**
- `q` / `Escape` / `y` — handled by tmux's `copy-mode-vi` bindings; the pane leaves `in_mode` and the
  reconciliation drops the client state.
- Scrolling back to the bottom of history with no active selection — `copyMode_scroll` auto-exits.
- A 2-second re-entry cooldown (`COPY_MODE_REENTRY_COOLDOWN`) prevents a stale `in_mode` flag from
  immediately re-opening copy mode after an exit.

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

When the app is not in a mouse-tracking mode, `usePaneMouse` drives the client selection:

- **Drag** — enters copy mode, starts a char selection at the drag origin, and extends it as the cursor
  moves (`COPY_MODE_SELECTION_START` / `COPY_MODE_CURSOR_MOVE`). Auto-scrolls when dragging past an edge.
- **Double-click** — selects the word under the cursor (`COPY_MODE_WORD_SELECT`).
- **Triple-click** — selects the whole logical line (`COPY_MODE_LINE_SELECT`), expanded across wrapped rows.
- **Wheel / touch** — scroll the native container; `onScroll` reports the new top row via `COPY_MODE_SCROLL`.

Mouse-tracking applications (`mouse_any_flag`, e.g. nvim/htop) receive forwarded SGR mouse sequences
instead — that path is unchanged.

## Clipboard

Selected text is extracted client-side (`extractSelectedText`, which joins wrapped rows into logical
lines). Keyboard yank (`y`/`Enter`) and `Ctrl/Cmd-C` set the extracted text on the keyboard actor's
native `copy` event (`document.execCommand('copy')` → `clipboardData`). The right-click **Copy** action
writes it via `navigator.clipboard.writeText`; the selection context menu also offers "Send keys", web
search, and other actions.

## Key files

| File | Responsibility |
|------|----------------|
| `packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx` | Virtual-scrolling renderer for loaded scrollback + client cursor/selection |
| `packages/tmuxy-ui/src/components/TerminalPane.tsx` | Chooses `ScrollbackTerminal` vs live `Terminal`; owns the native scroll container and `onScroll` |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode.ts` | XState actions: enter/exit, cursor/selection, scroll, chunk merge, prefetch |
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
