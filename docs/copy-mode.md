# Copy Mode

Tmuxy reimplements copy mode entirely on the client side. The frontend handles all vi keybindings, cursor movement, scrolling, selection, and clipboard operations. tmux's `copy-mode` is entered only to set the `in_mode` flag; tmux's cursor, selection, and keybindings are not used by the UI.

## Architecture

```
User input (keyboard/mouse/scroll)
    ↓
keyboardActor.ts — intercepts all keydown events when copy mode active
    ↓
appMachine.ts — COPY_MODE_KEY event → handleCopyModeKey()
    ↓
copyModeKeys.ts — pure function, returns updated CopyModeState + action
    ↓
ScrollbackTerminal.tsx — re-renders with new cursor/selection/scrollTop
```

When copy mode is **active**, the keyboard actor calls `preventDefault()` on every keydown, preventing browser shortcuts and terminal input. Keys are routed to the app machine as `COPY_MODE_KEY` events.

When copy mode is **inactive**, keys pass through to tmux normally.

## Entry and Exit

**Entry triggers:**
- Scroll away from bottom in normal mode (mouse wheel)
- Keyboard: `prefix + [` (sends `ENTER_COPY_MODE`)
- Right-click context menu (auto-enters if needed)

**Exit triggers:**
- `q` or `Escape` key
- `y` (yank — copies selection and exits)
- Scroll back to bottom of content
- Cooldown: 2-second re-entry delay after exit (server state lag)

**tmux interaction on enter/exit:**
- On enter: `copy-mode` command sent to tmux to set `in_mode` flag
- On exit: `send-keys -X cancel` sent to tmux to clear `in_mode` flag

## Vi Keybindings

### Cursor Motion
| Key | Action |
|-----|--------|
| `h` / `←` | Move left |
| `j` / `↓` | Move down |
| `k` / `↑` | Move up |
| `l` / `→` | Move right |

### Line Motion
| Key | Action |
|-----|--------|
| `0` / `Home` | Start of line |
| `$` / `End` | End of line |

### Word Motion
| Key | Action |
|-----|--------|
| `w` | Next word start |
| `b` | Previous word start |
| `e` | Word end |

### Page Motion
| Key | Action |
|-----|--------|
| `Ctrl+u` | Half page up |
| `Ctrl+d` | Half page down |
| `Ctrl+b` | Full page up |
| `Ctrl+f` | Full page down |

### Viewport-Relative
| Key | Action |
|-----|--------|
| `H` | Top of viewport |
| `M` | Middle of viewport |
| `L` | Bottom of viewport |

### Jump
| Key | Action |
|-----|--------|
| `gg` | Top of content |
| `G` | Bottom of content |

### Selection
| Key | Action |
|-----|--------|
| `v` | Toggle char selection mode |
| `V` | Toggle line selection mode |

### Yank / Exit
| Key | Action |
|-----|--------|
| `y` | Yank selection (copy to clipboard + exit) |
| `q` | Exit copy mode |
| `Escape` | Exit copy mode |

## Scrollback Loading

Scrollback content is loaded in lazy 200-line chunks from the server.

- `getNeededChunk()` checks if the viewport is within 50 lines of unloaded content
- When a chunk is needed, the app machine fetches it via SSE and merges it with `mergeScrollbackChunk()`
- `loadedRanges` tracks which line ranges have been fetched to avoid duplicate requests
- `isRowLoaded()` checks if a specific row is available

## Selection and Clipboard

Two selection modes:
- **Char mode** (`v`): selects from anchor position to cursor position, respecting column boundaries on first/last lines
- **Line mode** (`V`): selects full lines from anchor row to cursor row

`extractSelectedText()` builds the selected text string:
- Char mode: partial first/last lines, full middle lines
- Line mode: full-width lines with trailing spaces trimmed
- Returns newline-separated string

Clipboard write uses two mechanisms:
- **Yank (`y`) and `Ctrl+C` / `Cmd+C`**: `document.execCommand('copy')` triggered from the keyboard actor, with `pendingCopyText` set for the copy event handler.
- **Context menu "Copy"**: `navigator.clipboard.writeText()` triggered from `SelectionContextMenu.tsx`.

## tmux Interaction

tmux's copy mode is used minimally:
- `copy-mode` command on entry: sets `in_mode` flag in pane state (consumed by `list-panes` format)
- `send-keys -X cancel` on exit: clears `in_mode` flag

tmux's `copyCursorX` / `copyCursorY` (from `list-panes`) are **not** used by the copy mode engine. They reflect tmux's internal cursor, which is separate from the frontend's `cursorRow` / `cursorCol` in `CopyModeState`. The `Terminal.tsx` component renders tmux's native cursor when `in_mode` is true (for the non-scrollback terminal view), but `ScrollbackTerminal` uses the frontend's cursor exclusively.

## Key Files

| File | Role |
|------|------|
| `packages/tmuxy-ui/src/utils/copyModeKeys.ts` | Pure key handler — maps vi keys to state updates + actions |
| `packages/tmuxy-ui/src/utils/copyMode.ts` | Selection text extraction, scrollback chunk merging, chunk prefetch logic |
| `packages/tmuxy-ui/src/machines/app/appMachine.ts` | XState integration — `copyModeStates` context, event handlers for all copy mode events |
| `packages/tmuxy-ui/src/machines/actors/keyboardActor.ts` | DOM keyboard interception, copy mode key routing, clipboard operations |
| `packages/tmuxy-ui/src/components/TerminalPane.tsx` | Scroll detection (enter copy mode), conditional rendering (ScrollbackTerminal vs Terminal) |
| `packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx` | Virtual rendering of scrollback lines, cursor display, selection highlighting |
