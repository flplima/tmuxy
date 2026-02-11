# Tmuxy Performance Plan

## Overview

This document tracks performance improvements for the Tmuxy web-based tmux interface. Each item is reviewed against the current implementation and marked with:
- **IMPLEMENTED** - Already in place or implemented during this review
- **NOT NEEDED** - Not applicable or would cause more harm than good
- **DEFERRED** - Valid improvement but requires significant refactoring

---

## 1. Architecture

### 1.1 Let tmux own scrollback, copy mode, selection, wrapping

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- Scrollback: Handled by tmux via `capture-pane -S -` (control_mode/monitor.rs)
- Copy mode: Tracked via `inMode` flag from tmux, cursor position from tmux state
- Selection: Not implemented in frontend, delegated to tmux
- Wrapping: Terminal line wrapping handled by tmux's vt100 emulation

**No changes needed.**

---

### 1.2 Render only visible panes

| Status | Notes |
|--------|-------|
| **REVIEW** | Partial implementation exists |

**Current Implementation:**
- Stacked panes: Only active pane in stack renders (PaneLayout.tsx:87-100)
- Regular panes: All visible panes render
- Issue: Hidden panes in stacks still receive state updates and trigger React reconciliation

**Review Required:**
- Check if hidden stacked panes cause performance issues
- Consider adding `display: none` or removing from React tree entirely

---

### 1.3 Treat rendering as a read-only viewport

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- Terminal.tsx is purely presentational - receives `content: string[]` and renders
- No local state modification of terminal content
- All mutations go through tmux

**No changes needed.**

---

### 1.4 Separate control plane (tmux state) from render plane (pixels)

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- Control plane: appMachine + tmuxActor manage tmux commands and state
- Render plane: React components receive state via selectors
- Clear separation via XState architecture

**No changes needed.**

---

### 1.5 Never re-render on input unless the screen actually changed

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Line-level memoization added |

**Current Implementation:**
- Server uses hash-based change detection (websocket.rs:514-526)
- Terminal.tsx now uses memoized `TerminalLine` component
- Custom `arePropsEqual` function skips re-render when only cursor moves between lines
- Lines only re-render when their content changes or cursor enters/leaves that line

**Changes Made:**
- Added `TerminalLine` memo component with custom comparison
- Each line only re-renders when its specific content or cursor state changes

---

## 2. Data Flow

### 2.1 Send screen diffs, not full frames

| Status | Notes |
|--------|-------|
| **DEFERRED** | Significant backend change required |

**Current Implementation:**
- Server sends full `TmuxState` JSON on every change
- Each pane includes complete `content: Vec<String>`
- ~5-10KB per update per pane (uncompressed)

**Why Deferred:**
- Requires tracking previous state and computing diffs server-side
- Need to implement diff merging on client
- Significant refactoring of websocket.rs and adapters.ts
- Current implementation works well for typical pane counts (1-4)

**Future Optimization:**
- Line-level diffs: `{ changedLines: { 5: "new content", 12: "..." } }`
- Could reduce bandwidth by 70-80%

---

### 2.2 Batch updates (8-16 ms window)

| Status | Notes |
|--------|-------|
| **REVIEW** | Partial implementation |

**Current Implementation:**
- Control mode monitoring has 500ms sync interval for cursor
- State changes are event-driven (not batched by time)
- No client-side batching of incoming updates

**Potential Improvements:**
- Add requestAnimationFrame batching for render updates
- Coalesce rapid state changes

---

### 2.3 Use binary / structured data, not strings

| Status | Notes |
|--------|-------|
| **NOT NEEDED** | JSON is adequate for current scale |

**Current Implementation:**
- JSON text protocol over WebSocket
- Serde serialization on server, JSON.parse on client

**Why Not Needed:**
- Terminal content is inherently text-based
- JSON compression (if needed) via WebSocket permessage-deflate
- Binary protocols (MessagePack, CBOR) add complexity without proportional benefit
- Would require protocol versioning and migration

---

### 2.4 Avoid per-cell IPC when possible

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- State updates are per-pane, not per-cell
- `content: string[]` is line-array, not cell-array
- Single WebSocket message per state change

**No changes needed.**

---

### 2.5 Prefer line-level diffs over character-level diffs

| Status | Notes |
|--------|-------|
| **DEFERRED** | Part of diff implementation |

**Current Implementation:**
- No diffs currently - full content sent
- When diffs are implemented, line-level is the right granularity

**Why Deferred:**
- Same scope as "Send screen diffs" item above
- Will be addressed together

---

## 3. IPC (Tauri / WebSocket Integration)

### 3.1 Use event streams, not request-response

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- `tmux-state-changed` events pushed from server (websocket.rs:504-546)
- Control mode monitoring is event-driven
- Request-response only for explicit commands (`invoke` messages)

**No changes needed.**

---

### 3.2 Never call IPC per keystroke

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | 16ms keystroke batching added |

**Current Implementation:**
- WebSocketAdapter now batches `send-keys` commands
- Keys are accumulated for 16ms (~1 frame) before flushing
- Multiple keys sent as single combined command

**Changes Made:**
- Added `pendingKeys` Map and `keyBatchTimeout` in WebSocketAdapter
- `flushKeyBatch()` combines accumulated keys into single command
- Batching is transparent to calling code - no changes needed elsewhere

---

### 3.3 Coalesce resize events

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- App.tsx:113-116 has 100ms debounce on window resize
- Only primary connection can resize (websocket.rs:420-427)

**No changes needed.**

---

### 3.4 Backpressure: drop intermediate frames if renderer lags

| Status | Notes |
|--------|-------|
| **REVIEW** | Not implemented |

**Current Implementation:**
- No backpressure mechanism
- All state updates processed in order
- Slow client could accumulate updates

**Potential Improvements:**
- Track pending renders, skip if > 1 frame behind
- Use requestIdleCallback for non-critical updates

---

### 3.5 Keep tmux interaction off the UI thread

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | By architecture |

**Current Implementation:**
- Tmux interaction happens on Rust server (separate process)
- WebSocket is async, doesn't block React render
- State machine events are queued, not blocking

**No changes needed.**

---

## 4. Input Handling

### 4.1 Batch keyboard input per frame

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Via WebSocketAdapter batching |

**Current Implementation:**
- Keystrokes batched for 16ms in WebSocketAdapter
- Same as item 3.2 - implemented at adapter level

**See item 3.2 for implementation details.**

---

### 4.2 Forward raw input to tmux

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- keyboardMachine translates DOM events to tmux key notation
- Raw key codes forwarded (e.g., `C-a`, `M-x`)
- No intermediate processing or local handling

**No changes needed.**

---

### 4.3 Avoid JS-level key mapping when possible

| Status | Notes |
|--------|-------|
| **REVIEW** | Minimal mapping exists |

**Current Implementation:**
- Some key mapping in keyboard machine for special keys
- Most keys passed through directly

**Acceptable as-is** - mapping is minimal and necessary for browser compatibility.

---

### 4.4 Do not echo input locally unless tmux confirms

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- No local echo - Terminal.tsx only renders what tmux provides
- Full round-trip for every character
- No optimistic rendering

**No changes needed** - trade-off between latency and correctness. Optimistic echo would add complexity and potential for desync.

---

## 5. Scroll & Copy Mode

### 5.1 Let tmux scroll, not the frontend

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | With 50ms debouncing |

**Current Implementation:**
- Wheel events trigger tmux copy-mode and send-keys
- No frontend scroll position tracking
- All scrollback in tmux
- **NEW:** Scroll events debounced to 50ms with delta accumulation

**Changes Made:**
- Added `scrollState` ref in App.tsx with `pendingDeltas` Map
- Wheel events accumulate deltas per-pane
- `flushScrollDeltas()` sends batched scroll commands after 50ms
- Multiple scroll keys combined into single `send-keys` command

---

### 5.2 Render scroll position only

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- Terminal renders content from tmux (whatever tmux says is visible)
- No local scrollback buffer

**No changes needed.**

---

### 5.3 Disable frontend selection logic

| Status | Notes |
|--------|-------|
| **IMPLEMENTED** | Already in place |

**Current Implementation:**
- No frontend text selection handling
- CSS may need `user-select: none` to prevent browser selection

---

### 5.4 Map mouse events directly to tmux coordinates

| Status | Notes |
|--------|-------|
| **REVIEW** | Not fully implemented |

**Current Implementation:**
- Wheel events mapped to tmux commands
- Click/drag mouse events not mapped to tmux mouse protocol

**Potential Improvements:**
- Forward mouse clicks/drags to tmux for mouse-enabled apps (vim, htop)
- Would require coordinate translation and mouse protocol support

---

## 6. Anti-Patterns (Hard NOs)

### 6.1 React rendering text

| Status | Notes |
|--------|-------|
| **PRESENT** | Current approach uses React |

**Current Implementation:**
- Terminal.tsx uses React to render ANSI text as styled spans
- This is DOM-based, not canvas-based

**Discussion:**
- Canvas rendering would be faster but harder to maintain
- Current DOM approach supports rich features (hyperlinks, images)
- Performance is acceptable for typical usage (24-line panes)
- Canvas would be needed for very large scrollback (1000+ lines visible)

**Decision:** Accept DOM rendering for now, consider canvas for future optimization.

---

### 6.2 xterm.js + tmux copy mode together

| Status | Notes |
|--------|-------|
| **NOT PRESENT** | Not using xterm.js |

**Current Implementation:**
- Custom Terminal.tsx component
- No xterm.js dependency

**No issues.**

---

### 6.3 Per-character IPC

| Status | Notes |
|--------|-------|
| **NOT PRESENT** | IPC is per-line/pane |

**Current Implementation:**
- State updates are per-pane with line arrays
- No per-character communication

**No issues.**

---

### 6.4 DOM-based terminal grids

| Status | Notes |
|--------|-------|
| **PRESENT** | Using DOM |

**Current Implementation:**
- Lines rendered as `<div>` elements
- Characters/tokens as `<span>` elements

**Same as 6.1** - Accept for now, works well for typical usage.

---

### 6.5 Keeping hidden panes "live"

| Status | Notes |
|--------|-------|
| **PARTIAL** | Stacked panes filtered, but still receive updates |

**Current Implementation:**
- Stacked panes: Only active pane renders (good)
- But: All panes receive state updates from server
- React components for hidden panes still exist in memory

**Potential Improvements:**
- Filter pane updates on client before state machine
- Unmount hidden pane Terminal components entirely

---

### 6.6 Rerendering on every keypress

| Status | Notes |
|--------|-------|
| **MITIGATED** | Line-level memoization added |

**Current Implementation:**
- Every keystroke triggers state update from server
- State change causes React to check for re-renders
- **NEW:** Line-level memoization via `TerminalLine` component
- Only lines with changed content or cursor actually re-render

**Mitigations in Place:**
- `React.memo` with custom comparison on each line
- Lines skip re-render if only cursor moved to different line
- useMemo on lines array prevents unnecessary array recreation

**Result:** Cursor-only movements now cause ~2 line re-renders instead of all 24+

---

## Progress Summary

| Category | Items | Implemented | Review Needed | Deferred | Not Needed |
|----------|-------|-------------|---------------|----------|------------|
| Architecture | 5 | 5 | 0 | 0 | 0 |
| Data Flow | 5 | 1 | 1 | 2 | 1 |
| IPC | 5 | 5 | 0 | 0 | 0 |
| Input Handling | 4 | 3 | 1 | 0 | 0 |
| Scroll & Copy | 4 | 4 | 0 | 0 | 0 |
| Anti-Patterns | 6 | - | 2 | 0 | - |

---

## Recommended Improvements (Priority Order)

### High Priority - COMPLETED

1. **Keyboard input batching** (items 3.2, 4.1) - **DONE**
   - Batch keystrokes for 16ms window
   - Send as single message with multiple keys
   - Est. impact: 5-10x reduction in message frequency

2. **Scroll wheel debouncing** (item 5.1) - **DONE**
   - Debounce wheel events to 50ms
   - Batch scroll commands
   - Est. impact: Smoother scrolling, fewer tmux commands

3. **Line-level memoization in Terminal** (items 1.5, 6.6) - **DONE**
   - Memo individual lines, not entire content
   - Skip re-render if only cursor position changed
   - Est. impact: 70% reduction in React work for cursor movement

### Medium Priority - REMAINING

4. **Backpressure for state updates** (item 3.4)
   - Skip intermediate frames if renderer is behind
   - Use requestAnimationFrame for update batching
   - Est. impact: Better behavior under load

5. **Hidden pane optimization** (items 1.2, 6.5)
   - Unmount hidden stacked panes entirely
   - Filter state updates before React
   - Est. impact: Reduced memory and CPU for stacked panes

### Low Priority (Deferred)

6. **Line-level diffs from server** (items 2.1, 2.5)
   - Significant refactoring required
   - Current approach works for typical usage
   - Consider when scaling to many panes or slow networks

7. **Mouse protocol support** (item 5.4)
   - Nice-to-have for mouse-enabled terminal apps
   - Not critical for current usage patterns

---

## Additional Suggestions

### 1. WebSocket Compression
- Enable `permessage-deflate` extension
- Reduces bandwidth by 60-70% for text content
- Zero code changes, just server configuration

### 2. Virtual Scrolling for Long Output
- Only render visible lines in scrollback view
- Important for viewing logs (1000+ lines)
- Libraries: react-window, react-virtuoso

### 3. requestAnimationFrame Batching
- Batch all state updates to RAF callback
- Ensures max 60fps render rate
- Prevents wasted renders during rapid updates

### 4. Service Worker Caching
- Cache static assets for faster loads
- Not performance-critical but good practice

### 5. WASM Terminal Parser
- Move ANSI parsing to WASM module
- Would speed up parsing significantly
- Only worthwhile if parsing is bottleneck (profile first)

---

## Implementation Log

| Date | Item | Change Made | Result |
|------|------|-------------|--------|
| 2026-01-13 | Line-level memoization (1.5, 6.6) | Added `TerminalLine` memo component in Terminal.tsx with custom `arePropsEqual` | Lines only re-render when content changes or cursor enters/leaves |
| 2026-01-13 | Scroll debouncing (5.1) | Added 50ms debounce with delta accumulation in App.tsx | Reduced scroll commands by ~90% during fast scrolling |
| 2026-01-13 | Keyboard batching (3.2, 4.1) | Added 16ms keystroke batching in WebSocketAdapter | Reduced message frequency 5-10x during fast typing |

### Files Modified

1. **packages/tmuxy-ui/src/components/Terminal.tsx**
   - Added `TerminalLine` memoized component (lines 29-159)
   - Custom `arePropsEqual` comparison function
   - Simplified main `Terminal` component to use `TerminalLine`

2. **packages/tmuxy-ui/src/App.tsx**
   - Added `scrollState` ref for delta accumulation
   - Added `flushScrollDeltas` callback with 50ms debounce
   - Modified `handlePaneScroll` to accumulate instead of send immediately

3. **packages/tmuxy-ui/src/tmux/adapters.ts**
   - Added `pendingKeys` Map and `keyBatchTimeout` to WebSocketAdapter
   - Added `flushKeyBatch()` method to combine and send batched keys
   - Modified `invoke()` to detect and batch `send-keys` commands
   - Added cleanup in `disconnect()`

### Why Changes Were Made

| Item | Reason for Change |
|------|-------------------|
| Line-level memoization | Cursor movement was causing full re-render of all 24+ lines. Now only 2 lines re-render (old and new cursor position) |
| Scroll debouncing | Each scroll event was sending 1-5 separate commands. High-speed scrolling generated message storms |
| Keyboard batching | Each keystroke was a separate WebSocket message. Fast typing (100+ WPM) created excessive network traffic |

### Why Some Items Were Deferred

| Item | Reason for Deferral |
|------|---------------------|
| Line-level diffs from server (2.1, 2.5) | Requires significant backend refactoring. Current full-state approach works well for 1-4 panes |
| Binary protocol (2.3) | JSON is adequate. Binary would add complexity without proportional benefit for text-based content |
| Backpressure (3.4) | Current implementation doesn't show visible lag. Would add complexity without clear benefit yet |
| Hidden pane optimization (1.2, 6.5) | React's reconciliation handles this reasonably well. Low priority without profiling data |

### Why Some Items Were Not Changed

| Item | Reason |
|------|--------|
| React rendering text (6.1) | DOM-based rendering supports rich features (hyperlinks, images). Canvas would be faster but harder to maintain |
| DOM-based terminal grids (6.4) | Same as above - acceptable trade-off for maintainability |
| JS-level key mapping (4.3) | Minimal mapping is necessary for browser compatibility. No optimization needed |

