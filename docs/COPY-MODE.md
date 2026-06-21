# Copy Mode

Tmuxy uses tmux's **native copy mode**. tmux owns the cursor, selection, scrollback, and all
keybindings; the frontend forwards input and renders what tmux reports. There is no client-side
scrollback buffer and no reimplementation of vi keybindings — consistent with the no-local-scrollback
principle in [NON-GOALS.md](NON-GOALS.md).

## Architecture

```
Input (keyboard / mouse / wheel)
    │
    ├─ keyboard ─────────────────────────────────────────────────────────────────┐
    │     keyboardActor.ts forwards keys via send-keys; while a pane is in copy    │
    │     mode tmux interprets them with its copy-mode-vi table (h/j/k/l, v, y, …) │
    │                                                                              ▼
    ├─ wheel / touch ──────────────────────────────────────────────────┐   tmux control mode
    │     usePaneMouse.ts / usePaneTouch.ts → scrollUtils.ts emit        │   (send-keys -X …,
    │     `copy-mode -e` + `send-keys -X scroll-up/down`                 │    copy-mode, etc.)
    │                                                                    ▼
    └─ mouse drag / click ──────────────────────────────────────►  nativeCopyMode.ts builders
          translate cells → `-X` commands (begin-selection,             (top-line, cursor-down -N,
          cursor positioning, copy-selection-and-cancel)                 cursor-right -N, …)
                                                                              │
                                                                              ▼
   tmux updates pane state (in_mode, copy_cursor_x/y, selection_present, selection_start_x/y)
   and the scrolled viewport content; the monitor's fast sync tick captures it
                                                                              │
                                                                              ▼
   Terminal.tsx renders pane.content + the copy cursor + the selection from tmux's coordinates
```

There is no separate copy-mode renderer: `TerminalPane` always renders the live `Terminal`, which draws
tmux's copy cursor and selection when `pane.inMode` is true.

## Entry and Exit

**Entry:**
- `prefix + [` (handled entirely by tmux)
- Wheel-up / touch-scroll-up in a normal shell — `scrollUtils.ts` sends `copy-mode -e` then `scroll-up`
- Mouse drag, double-click (word), or triple-click (line) — `usePaneMouse.ts` enters copy mode and
  begins a selection

**Exit:**
- `q` / `Escape` / `y` (handled by tmux's copy-mode-vi bindings)
- Scrolling back to the bottom — `copy-mode -e` auto-exits at the bottom of history
- Releasing a drag — `copy-selection-and-cancel` copies and leaves copy mode

`copy-mode -e` is idempotent: re-issuing it while already in copy mode does not reset the scroll
position, so repeated wheel ticks accumulate correctly.

## Keybindings

All copy-mode keybindings are tmux's own (the `copy-mode-vi` table). Keys flow through the normal
`send-keys` path in `keyboardActor.ts`; tmux interprets them while the pane is in copy mode. tmuxy does
not intercept or reinterpret them. To customize bindings, configure tmux (e.g. in the bundled
`.devcontainer/.tmuxy.defaults.conf`).

## Mouse

tmuxy speaks to tmux only through control-mode **commands** — there is no path for raw mouse events to
reach tmux's mouse layer. So mouse gestures are translated into `send-keys -X` copy-mode commands by
`nativeCopyMode.ts`:

- **Drag** — enter copy mode, anchor a selection at the drag-start cell, and reposition the cursor to
  the current cell as the mouse moves (tmux extends the selection). Visual feedback during a drag is
  bounded by the monitor's sync-tick cadence (see [TMUX.md](TMUX.md)).
- **Double-click** — select the word under the cursor (`previous-word` → `begin-selection` →
  `next-word-end`).
- **Triple-click** — select the whole line.
- Cursor positioning is absolute: jump to the top visible line, step down to the target row, reset to
  column 0, step right to the target column. `cursor-right` clamps at end-of-line, so clicks past a
  line's content land on its last cell.

Mouse-tracking applications (those with `mouse_any_flag`, e.g. nvim/htop) still receive forwarded SGR
mouse sequences instead — that path is unchanged.

## Clipboard

tmux does **not** forward OSC 52 to a control-mode client, so a copy-mode yank never reaches the
per-pane OSC parser. Instead, tmux emits a `%paste-buffer-changed` control-mode notification whenever a
buffer is created or updated (e.g. on yank). The monitor reacts by reading the buffer with `show-buffer`
(a read-only command, safe to run externally) and mirroring it to the browser through the existing
clipboard pipeline, which calls `navigator.clipboard.writeText`. Application-emitted OSC 52 still flows
through the per-pane OSC parser as before.

## Key Files

| File | Role |
|------|------|
| `packages/tmuxy-ui/src/utils/nativeCopyMode.ts` | Pure builders for the `send-keys -X` copy-mode commands (scroll, goto-cell, selection) |
| `packages/tmuxy-ui/src/hooks/scrollUtils.ts` | Routes wheel/touch scroll to SGR events, arrow keys, or native copy-mode scroll |
| `packages/tmuxy-ui/src/hooks/usePaneMouse.ts` | Mouse → native copy-mode commands (drag/word/line select, wheel, SGR forwarding) |
| `packages/tmuxy-ui/src/hooks/usePaneTouch.ts` | Touch scroll → native copy-mode scroll |
| `packages/tmuxy-ui/src/machines/actors/keyboardActor.ts` | Forwards keys to tmux (no copy-mode interception) |
| `packages/tmuxy-ui/src/components/Terminal.tsx` | Renders the copy cursor and selection from tmux's reported coordinates |
| `packages/tmuxy-core/src/control_mode/monitor.rs` | Handles `%paste-buffer-changed` → `show-buffer` → clipboard bridge |

## Related

- [NON-GOALS.md](NON-GOALS.md) — Why tmuxy keeps no local scrollback buffer
- [TMUX.md](TMUX.md) — Control-mode command routing and the sync-tick that captures scrolled content
- [DATA-FLOW.md](DATA-FLOW.md) — SSE/HTTP protocol and the clipboard event
