# Tmuxy Performance Optimization Research

A focused analysis of performance optimizations specific to Tmuxy's architecture: a tmux frontend using WebSocket/Tauri communication with React rendering.

## Executive Summary

Tmuxy is **not a traditional terminal emulator**. It's a **tmux frontend** that receives pre-processed state from tmux via control mode. This fundamentally changes which optimizations apply:

| Traditional Terminal | Tmuxy Architecture |
|---------------------|-------------------|
| Parses raw PTY stream | Tmux parses PTY, sends events |
| Manages scrollback buffer | Tmux manages scrollback |
| Emulates terminal (VT100) | vt100 crate in Rust backend |
| Renders all text to screen | Only receives visible lines |
| Direct keyboard → PTY | WebSocket/Tauri → tmux |

**Key Insight**: Many terminal emulator optimizations (virtualization, ring buffers, GPU rendering) don't apply. Instead, focus on:
1. **Communication efficiency** (WebSocket/Tauri protocol)
2. **State serialization** (delta updates, binary format)
3. **Avoiding double-parsing** (ANSI parsed twice currently)
4. **Tmux-specific batching** (control mode commands)

---

## Table of Contents

1. [Architecture Analysis](#1-architecture-analysis)
2. [What Doesn't Apply](#2-what-doesnt-apply-from-terminal-emulators)
3. [Tmuxy-Specific Bottlenecks](#3-tmuxy-specific-bottlenecks)
4. [Implementation Plan](#4-implementation-plan)
5. [References](#5-references)

---

## 1. Architecture Analysis

### 1.1 Current Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                           TMUX SERVER                                │
│  • Manages PTY for each pane                                        │
│  • Parses escape sequences                                          │
│  • Maintains scrollback buffer                                      │
│  • Handles all terminal emulation                                   │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ Control Mode Events
                                │ (%output, %layout-change, etc.)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        RUST BACKEND                                  │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │  Control Mode   │───▶│ StateAggregator │───▶│ TmuxState JSON  │ │
│  │  Connection     │    │ + vt100 Parser  │    │ (full state)    │ │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘ │
│           │                                              │          │
│           │ capture-pane -e                              │          │
│           │ (on resize/new pane)                         │          │
│           ▼                                              ▼          │
│  ┌─────────────────┐                        ┌─────────────────────┐│
│  │  list-panes     │                        │ WebSocket Broadcast ││
│  │  list-windows   │                        │ (serde_json)        ││
│  │  (500ms sync)   │                        └─────────────────────┘│
│  └─────────────────┘                                    │          │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ JSON over WebSocket
                                │ {"type":"event","name":"tmux-state-changed",...}
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         REACT FRONTEND                               │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │  XState Machine │───▶│   Selectors     │───▶│  React Render   │ │
│  │  (tmuxActor)    │    │ (O(N²) filter)  │    │                 │ │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘ │
│                                                         │          │
│                                                         ▼          │
│                                                ┌─────────────────┐ │
│                                                │  TerminalLine   │ │
│                                                │  Anser.parse()  │◀── ANSI parsed AGAIN
│                                                │  (per line)     │ │
│                                                └─────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Key Observations

1. **Double ANSI Parsing**:
   - Rust: vt100 parses → `get_content()` re-encodes to ANSI strings (state.rs:140-225)
   - React: Anser parses ANSI strings again (TerminalLine.tsx)
   - **Wasteful**: Parse once, send structured data

2. **Full State on Every Update**:
   - Every `%output` event → full `TmuxState` JSON broadcast
   - Includes ALL pane contents, even unchanged ones
   - For 4 panes × 24 lines × 80 chars = ~7.7KB per update minimum

3. **Control Mode Already Event-Driven**:
   - Tmux tells us exactly what changed
   - We ignore this and rebuild full state anyway

4. **500ms Periodic Sync**:
   - Calls `list-panes` and `list-windows` every 500ms
   - Needed for cursor position accuracy
   - Could be smarter (only when needed)

---

## 2. What Doesn't Apply (From Terminal Emulators)

### 2.1 GPU Rendering / WebGL

**Why terminals use it**: Rendering 10,000+ glyphs with complex styling.

**Why Tmuxy doesn't need it**:
- Only ~24-50 visible lines per pane
- React DOM rendering is sufficient
- No scrollback rendered (tmux owns it)

### 2.2 Texture Atlas / Glyph Caching

**Why terminals use it**: Avoid re-rasterizing fonts for each character.

**Why Tmuxy doesn't need it**:
- Browser handles font rendering natively
- CSS styling is already hardware-accelerated

### 2.3 Viewport Virtualization

**Why terminals use it**: Only render visible rows of 100,000+ line scrollback.

**Why Tmuxy doesn't need it**:
- Tmux sends only visible content via `capture-pane`
- No scrollback in frontend to virtualize
- ~24-50 lines is trivial for React

### 2.4 Ring Buffer / Scrollback Management

**Why terminals use it**: Fixed memory for unlimited scrollback.

**Why Tmuxy doesn't need it**:
- Tmux manages scrollback server-side
- Frontend only holds visible content

### 2.5 Zero-Allocation PTY Parser

**Why terminals use it**: Parse millions of bytes/sec from PTY.

**Why Tmuxy doesn't need it**:
- Tmux already parsed the PTY
- We receive structured events, not raw bytes

### 2.6 SIMD Escape Sequence Detection

**Why terminals use it**: Find escape sequences in massive byte streams.

**Why Tmuxy doesn't need it**:
- Control mode sends pre-parsed events
- ANSI in content is relatively sparse

---

## 3. Tmuxy-Specific Bottlenecks

### 3.1 Critical: Double ANSI Parsing

**Current Flow**:
```
Tmux PTY → vt100::Parser (Rust) → ANSI string → JSON → Anser (JS) → React spans
```

**Problem**: Parsing ANSI twice wastes CPU. The vt100 parser already has structured cell data.

**Solution**: Send structured cell data, not ANSI strings.

### 3.2 Critical: Full State Serialization

**Current**: Every update sends complete `TmuxState` (~10-50KB).

**Problem**: Typing a single character broadcasts all pane contents.

**Evidence**: `websocket.rs:30-35` - `emit_state()` serializes entire state.

### 3.3 High: Control Mode Event Ignorance

**Current**: Control mode tells us `%output %0 \x1b[32mhello` but we:
1. Feed it to vt100 parser
2. Rebuild entire state
3. Serialize everything
4. Send to all clients

**Better**: Use the event to update only the affected pane, send delta.

### 3.4 Medium: Capture-Pane Cascade

**Current**: Layout change → synchronous `capture-pane` for each resized pane.

**Problem**: Split into 4 panes = 4 sequential tmux commands.

### 3.5 Medium: Selector Recalculation

**Current**: `selectVisiblePanes` runs O(N×M) on every state update.

**Problem**: Filters all panes through all stacks on every render.

### 3.6 Low: Status Line Per State

**Current**: `to_tmux_state()` calls `capture_status_line()` every time.

**Problem**: Unnecessary tmux command on every state update.

---

## 4. Implementation Plan

### Priority Legend
- **P0**: Critical - large impact, blocks good UX
- **P1**: Important - significant improvement
- **P2**: Nice to have - incremental gain
- **P3**: Polish - minor improvement

### Effort Legend
- **S**: Small (< 2 hours)
- **M**: Medium (2-4 hours)
- **L**: Large (4-8 hours)
- **XL**: Extra Large (8+ hours)

---

### P0: Critical Optimizations

#### 4.1 Delta State Protocol
**Effort: L | Impact: ~70% bandwidth reduction**

Only send what changed instead of full state.

- [ ] Track previous state hash per pane in Rust
- [ ] Compute which panes/windows changed
- [ ] Define delta message format:
  ```typescript
  type TmuxDelta = {
    type: 'delta';
    seq: number;  // For ordering
    panes?: {
      [id: string]: {
        content?: string[];  // Only if changed
        cursor?: { x: number; y: number };
        active?: boolean;
      } | null;  // null = removed
    };
    windows?: { [id: string]: Partial<TmuxWindow> | null };
    activePane?: string;
    activeWindow?: string;
    statusLine?: string;  // Only if changed
  };
  ```
- [ ] Frontend merges deltas into current state
- [ ] Keep full state sync for reconnection (`get_initial_state`)
- [ ] Add sequence numbers for ordering

#### 4.2 Eliminate Double ANSI Parsing
**Effort: L | Impact: ~50% CPU reduction in frontend**

Send pre-parsed cell data instead of ANSI strings.

**Option A: Structured cells from Rust**
- [ ] Define cell format: `{ char: string, fg?: string, bg?: string, bold?: bool, ... }`
- [ ] Modify `PaneState::get_content()` to return `Vec<Vec<Cell>>` instead of `Vec<String>`
- [ ] Update `TmuxPane.content` type
- [ ] Remove Anser dependency from frontend
- [ ] Render cells directly to spans

**Option B: Parse once, cache in frontend**
- [ ] Cache parsed results keyed by line content
- [ ] Skip parsing if line unchanged
- [ ] LRU cache with 1000 entry limit

**Recommendation**: Option A is cleaner but more work. Option B is quick win.

#### 4.3 Leverage Control Mode Events ✅
**Effort: M | Impact: Smarter updates**

Use control mode event type to determine update scope.

- [x] Add `ChangeType` enum to categorize events (PaneOutput, PaneLayout, Window, PaneFocus, Session, Full)
- [x] Return change type from `process_event()` for smarter emission strategies
- [x] Implement 16ms output debouncing - rapid output events batched, layout/window changes emit immediately
- [x] Non-output changes (layout, window focus) bypass debouncing for instant feedback
- [x] Prepares for delta state protocol (4.1) by providing semantic change information

---

### P1: Important Optimizations

#### 4.4 Batch Capture-Pane Commands ✅
**Effort: M | Impact: Faster layout changes**

Execute multiple captures in parallel.

- [x] Add `send_commands_batch()` to ControlModeConnection - writes all commands then single flush
- [x] Batch capture-pane commands in monitor.rs - collect all, single batch send
- [x] Batch periodic sync commands (list-windows + list-panes) in single flush
- [x] Reduces system calls and improves write efficiency

#### 4.5 Lazy Status Line Updates
**Effort: S | Impact: Fewer tmux commands**

Only fetch status line when likely changed.

- [ ] Cache last status line in StateAggregator
- [ ] Only refresh on:
  - Window change events
  - 500ms periodic sync
  - Explicit refresh request
- [ ] Skip on `%output` events

#### 4.6 Selector Memoization ✅
**Effort: M | Impact: ~30% render reduction**

Prevent unnecessary selector recalculations.

- [x] Create custom memoization utility (`utils/memoize.ts`)
- [x] Memoize `selectPreviewPanes` - tracks panes, resize state, char dimensions
- [x] Memoize `selectVisiblePanes` - improved from O(N×M) to O(N+M) using Set
- [x] Memoize `selectPanePixelDimensions` - expensive Map creation cached
- [x] Memoize `selectStackForPane` and `selectPaneById` with argument caching

#### 4.7 Frontend ANSI Cache
**Effort: S | Impact: ~30% parse reduction**

Cache parsed ANSI results (quick win before 4.2).

- [ ] Add `Map<string, ParsedLine>` cache
- [ ] Key: line content string
- [ ] Check cache before calling `Anser.ansiToJson()`
- [ ] Clear cache when pane content fully replaced

#### 4.8 Style Object Pooling
**Effort: S | Impact: ~20% GC reduction**

Reuse style objects for common ANSI combinations.

- [ ] Create style cache: `Map<string, CSSProperties>`
- [ ] Key: `${fg},${bg},${bold},${italic},${underline}`
- [ ] Pre-populate with 16 standard ANSI colors
- [ ] Limit to 256 entries

---

### P2: Nice-to-Have Optimizations

#### 4.9 Binary WebSocket Protocol
**Effort: L | Impact: ~40% bandwidth reduction**

Replace JSON with binary format.

- [ ] Use MessagePack or Protocol Buffers
- [ ] Smaller payload than JSON
- [ ] Faster serialization/deserialization
- [ ] Consider: adds complexity, harder to debug

#### 4.10 WebSocket Compression
**Effort: M | Impact: ~30% bandwidth for large content**

Enable permessage-deflate.

- [ ] Enable in Axum WebSocket config
- [ ] Test compression ratio on typical payloads
- [ ] Monitor CPU overhead

#### 4.11 Tauri-Specific IPC Optimization
**Effort: M | Impact: Lower latency for Tauri**

Tauri IPC is faster than WebSocket - use it efficiently.

- [ ] Use Tauri events instead of WebSocket for Tauri builds
- [ ] Consider shared memory for large state
- [ ] Benchmark IPC vs WebSocket latency

#### 4.12 Frame Coalescing
**Effort: S | Impact: Smoother rapid updates**

Batch rapid state updates into single render.

- [ ] Debounce state updates: 16ms (60fps)
- [ ] Or use `requestAnimationFrame` batching
- [ ] Always render latest state

#### 4.13 Smart Cursor Blink
**Effort: S | Impact: Reduced animation overhead**

Disable cursor animation during rapid updates.

- [ ] Track last update timestamp
- [ ] Disable blink if update within 100ms
- [ ] Re-enable after 500ms idle

#### 4.14 Compile Regexes Once
**Effort: S | Impact: ~5% parse time**

Move regex compilation to module scope in richContentParser.ts.

- [ ] Define regexes as module constants
- [ ] Reset `lastIndex` before each use (for global regexes)

---

### P3: Polish Optimizations

#### 4.15 Reduce Periodic Sync Frequency
**Effort: S | Impact: Fewer tmux commands**

500ms might be more frequent than needed.

- [ ] Test 1000ms sync interval
- [ ] Only sync when window has focus
- [ ] Skip sync if no recent activity

#### 4.16 Framer Motion Optimization
**Effort: S | Impact: Animation CPU**

- [ ] Use `layout="position"` for non-animating panes
- [ ] Disable spring animation during drag

#### 4.17 ResizeObserver Throttling
**Effort: S | Impact: Fewer re-renders**

- [ ] Throttle to 100ms
- [ ] Only update if size changed by > 2px

---

## 5. Implementation Phases

### Phase 1: Quick Wins (1-2 days) ✅ COMPLETED
- [x] 4.5 Lazy Status Line Updates (S) - Cached status line, only refresh on window events
- [x] 4.7 Frontend ANSI Cache (S) - LRU cache for parsed ANSI (1000 entries)
- [x] 4.8 Style Object Pooling (S) - LRU cache for style objects (256 entries)
- [x] 4.13 Smart Cursor Blink (S) - Disabled blink during rapid updates via activity tracker
- [x] 4.14 Compile Regexes Once (S) - Moved to module scope with lastIndex reset

**Expected Impact**: 20-30% improvement in render performance

### Phase 2: Core Protocol (3-5 days)
- [ ] 4.1 Delta State Protocol (L)
- [x] 4.3 Leverage Control Mode Events (M) - ChangeType enum + 16ms output debouncing
- [x] 4.4 Batch Capture-Pane Commands (M) - `send_commands_batch()` with single flush
- [x] 4.6 Selector Memoization (M) - Custom memoization + O(N+M) algorithm

**Expected Impact**: 50-70% bandwidth reduction, faster updates

### Phase 3: Eliminate Double Parsing (3-4 days)
- [ ] 4.2 Structured Cell Data (L)

**Expected Impact**: 40-50% CPU reduction in frontend

### Phase 4: Polish
- [ ] 4.9-4.17 as needed

---

## 6. Tmux-Specific Opportunities

### 6.1 Use Tmux Hooks

Tmux supports hooks that run commands on events:

```bash
# Run command when pane content changes
set-hook -g pane-set-clipboard 'run-shell "notify-tmuxy"'
```

Could potentially reduce polling needs.

### 6.2 Control Mode Command Batching

Send multiple commands in single control mode input:

```
list-panes -F '...'
list-windows -F '...'
```

Reduces round-trips.

### 6.3 Tmux Formats for Efficient Data

Use tmux format strings to get exactly needed data:

```bash
tmux list-panes -F '#{pane_id},#{pane_width},#{pane_height},#{cursor_x},#{cursor_y}'
```

Avoid parsing complex output.

### 6.4 Synchronized Updates (Future)

Tmux 3.2+ supports synchronized updates:
- `\ePtmux;...\e\\` sequences
- Could batch multiple changes atomically

---

## 7. Benchmarking Targets

| Metric | Current (est.) | Target |
|--------|----------------|--------|
| Keypress → display | ~50-100ms | < 16ms |
| State update size | 10-50KB | < 2KB (delta) |
| State updates/sec | ~10-20 | 60 (coalesced) |
| ANSI parse time | 2x (double) | 1x (single) |
| Memory per pane | ~2MB | < 500KB |

### Measurement Tools

1. **React DevTools Profiler**: Component render times
2. **Chrome DevTools Network**: WebSocket message sizes
3. **`console.time()`**: Parse/render timing
4. **Rust tracing**: Backend event processing
5. **tmux timing**: `time tmux capture-pane`

---

## 8. References

### Tmux Documentation
- [Tmux Control Mode](https://github.com/tmux/tmux/wiki/Control-Mode)
- [Tmux Formats](https://man7.org/linux/man-pages/man1/tmux.1.html#FORMATS)
- [Tmux Hooks](https://man7.org/linux/man-pages/man1/tmux.1.html#HOOKS)

### Terminal Emulator Insights (What We Borrowed)
- [Kitty repaint_delay](https://sw.kovidgoyal.net/kitty/conf/#opt-kitty.repaint_delay) - Frame coalescing concept
- [xterm.js dirty tracking](https://github.com/xtermjs/xterm.js) - Delta update concept
- [Alacritty batching](https://jwilm.io/blog/announcing-alacritty/) - Frame coalescing

### React Performance
- [Reselect](https://github.com/reduxjs/reselect) - Selector memoization
- [React.memo](https://react.dev/reference/react/memo) - Component memoization
- [useDeferredValue](https://react.dev/reference/react/useDeferredValue) - Deferred updates

### Rust/WebSocket
- [Axum WebSocket](https://docs.rs/axum/latest/axum/extract/ws/index.html)
- [tokio::join!](https://docs.rs/tokio/latest/tokio/macro.join.html) - Parallel execution
- [serde_json performance](https://github.com/serde-rs/json#performance)

---

## 9. Implementation Status

### Summary (as of 2026-01-17)

**Tests**: 91/91 E2E tests passing, 9/9 unit tests passing

**Phase 1: Quick Wins** ✅ COMPLETE
- [x] 4.5 Lazy Status Line Updates
- [x] 4.7 Frontend ANSI Cache
- [x] 4.8 Style Object Pooling
- [x] 4.13 Smart Cursor Blink
- [x] 4.14 Compile Regexes Once

**Phase 2: Core Protocol** ✅ COMPLETE
- [x] 4.1 Delta State Protocol (StateUpdate enum, PaneDelta, WindowDelta, frontend merging)
- [x] 4.3 Leverage Control Mode Events (ChangeType enum + 16ms debouncing)
- [x] 4.4 Batch Capture-Pane Commands (single flush optimization)
- [x] 4.6 Selector Memoization (custom memoization + O(N+M) algorithm)

**Phase 3: Eliminate Double Parsing** ✅ COMPLETE
- [x] 4.2 Structured Cell Data
  - Added TerminalCell, CellStyle, CellColor types in Rust
  - PaneContent enum supports both legacy ANSI strings and structured cells
  - get_content() now returns pre-parsed cells with styling
  - Frontend TerminalLine renders cells directly without Anser parsing
  - Backwards compatible with legacy ANSI format

**Phase 4: Polish** - IN PROGRESS
- [ ] Various small optimizations

### Files Modified

**Rust Backend (tmuxy-core)**
- `lib.rs` - NEW: TerminalCell, CellStyle, CellColor, PaneContent types; Delta types (PaneDelta, WindowDelta, TmuxDelta, StateUpdate)
- `control_mode/state.rs` - ChangeType enum, lazy status line, event categorization, `get_content()` returns structured cells, `to_state_update()` for delta computation
- `control_mode/monitor.rs` - Output debouncing, batch command execution, StateEmitter uses StateUpdate
- `control_mode/connection.rs` - `send_commands_batch()` for efficient multi-command sends
- `control_mode/mod.rs` - Export ChangeType

**Web Server**
- `websocket.rs` - MonitorConfig with output_debounce, WebSocketEmitter handles StateUpdate

**React Frontend (tmuxy-ui)**
- `tmux/types.ts` - NEW: CellColor, CellStyle, TerminalCell, CellLine, PaneContent types; Updated ServerPane, PaneDelta
- `tmux/adapters.ts` - Delta protocol handling: `handleStateUpdate()`, `applyDelta()`, `applyPaneDelta()`, `applyWindowDelta()`
- `components/TerminalLine.tsx` - Dual rendering: structured cells (new) and ANSI strings (legacy); cell grouping optimization
- `components/Terminal.tsx` - Updated to handle PaneContent (both cells and ANSI)
- `utils/memoize.ts` - NEW: Custom memoization utilities
- `machines/selectors.ts` - Memoized selectors with O(N+M) algorithm
- `hooks/useActivityTracker.ts` - NEW: Activity tracking for smart cursor blink
- `components/Cursor.tsx` - Smart blink during rapid updates
- `utils/ansiStyles.ts` - Style object pooling
- `utils/richContentParser.ts` - Pre-compiled regexes with lastIndex reset
- `machines/app/tmuxActor.ts` - Activity recording on state updates

### Estimated Impact

The implemented optimizations provide:

**Phase 1 (Quick Wins):**
- **~30-40% reduction** in unnecessary React re-renders (memoization)
- **Lower GC pressure** (object pooling, caching)
- **Faster regex matching** (pre-compiled patterns)
- **Reduced animation overhead** (smart cursor blink)

**Phase 2 (Core Protocol):**
- **~70% bandwidth reduction** (delta state protocol - only send changes)
- **~60fps throttling** for rapid output (16ms debouncing)
- **Reduced system calls** (batched capture-pane commands)
- **O(N+M) selector algorithm** (down from O(N×M))

**Phase 3 (Eliminate Double Parsing):**
- **~50% CPU reduction** in frontend (no Anser parsing for cell content)
- **Zero parsing overhead** for structured cell data
- **More efficient serialization** (compact cell format with optional styles)
- **Backwards compatible** with legacy ANSI format

**Total Estimated Improvement:**
- Keypress → display latency: ~50-100ms → ~16-32ms
- State update size: ~10-50KB → ~0.5-2KB (delta)
- Frontend parse time: 2x → 1x (eliminated double parsing)
- Memory per pane: ~2MB → ~500KB (no parsed ANSI cache needed)
