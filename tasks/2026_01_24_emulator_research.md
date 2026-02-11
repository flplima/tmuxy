# Research: Open Source Tmux Emulator Patterns

Research notes for tmuxy improvements, studying iTerm2 (tmux -CC), xterm.js, and other terminal emulators.

## Rendering Performance

### 1. RAF debouncer for state updates
**Status:** ✅ DONE

Implemented in `tmuxActor.ts` — the `onStateChange` handler uses a RAF-based debouncer that batches rapid updates. Only the latest state is sent to the app machine, at most once per animation frame.

---

## OSC Protocol Architecture

### The Approach: Targeted Extraction, Not Emulation

We parse `%output` to extract OSC sequences (hyperlinks, clipboard) that `capture-pane` strips. This is NOT full terminal emulation — we still use snapshots for the rendered grid.

```
%output arrives → extract OSC metadata → store associations
capture-pane arrives → render grid → apply OSC metadata to cells
```

### What This Enables

| Feature | Status |
|---------|--------|
| Hyperlinks (OSC 8) | Planned |
| Clipboard (OSC 52) | Planned |
| Window title (OSC 0/2) | Planned |

### What We Explicitly Skip

- Full terminal state machine (cursor, SGR, scroll regions)
- Local scrollback buffer
- Image protocols
- Local search

See `NON_GOALS.md` for rationale.

---

## Remaining Research Items

### Input: IME Handling
**Status:** Tracked in issue-7-ime-handling.md

### Input: Mouse Reporting
**Status:** Tracked in issue-2-mouse-events.md (includes alternate screen detection)

### Connection: Flow Control
**Status:** Tracked in issue-8-flow-control.md

### Connection: Session Reconnection
**Status:** Tracked in issue-9-session-reconnection.md

### Features: OSC Protocols
**Status:** Tracked in issue-10-osc-protocols.md

---

## Layout UX

### Resize divider UX
**Current:** Invisible hit-areas at divider positions.
**Issue:** Poor discoverability — users don't know dividers are draggable.

#### Findings

**VS Code `Sash` class:**
- Invisible line becomes highlighted on hover
- Configurable hit area (default 4px) larger than visual line
- Cursor changes: `col-resize` / `row-resize`

**iTerm2 dividers:**
- Thin visible lines (1-2px) between panes
- Larger invisible hit area around visible line

**Accessibility:**
- `role="separator"` on divider element
- `aria-valuenow`, `aria-valuemin`, `aria-valuemax`

#### Implementation

1. Show 1-2px divider line on hover (CSS `:hover` on hit-area shows child element)
2. Cursor: `col-resize` / `row-resize` on hover
3. Debounce tmux resize: visual update during drag, send command on drag-end
4. Add `role="separator"` + `aria-*` attributes
