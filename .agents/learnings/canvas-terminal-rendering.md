# Canvas Terminal Rendering: Why Not For This App

## Context

Evaluated replacing DOM-based terminal rendering (`<span>` elements) with HTML Canvas for the tmuxy UI. Decided against it.

## Current Architecture

- Tmux handles all terminal state (parsing, scrolling, cursor, copy mode)
- Rust backend captures pane content as pre-parsed structured cells (`{ c: string, s?: CellStyle }`)
- React UI renders cells as styled `<span>` elements grouped by style (TerminalLine.tsx)
- Updates arrive at most once per animation frame (RAF batching in tmuxActor)
- TerminalLine uses `React.memo` with custom comparison — only re-renders when line content or cursor state changes
- Typical pane: 80x24 = 1,920 cells, grouped into ~5-30 spans per line

## Why Canvas Doesn't Help Here

### Test compatibility requires keeping the DOM

E2E tests (50+ tests across 14 files) query terminal content via:
- `[role="log"]` + `.textContent` for text assertions
- `getComputedStyle(span).color` for ANSI color verification
- `.terminal-cursor` + `getBoundingClientRect()` for cursor detection
- `.terminal-content .terminal-line span` iteration for snapshot comparison

To maintain test compatibility, a hidden DOM text layer must be preserved alongside the canvas. This means React still reconciles the full TerminalLine component tree on every update. The canvas becomes **additional** work, not a replacement.

### No performance bottleneck in rendering

The bottleneck (if any) is WebSocket message processing and state machine updates, not DOM painting. With TerminalLine memoization, unchanged lines skip re-rendering entirely. The browser efficiently paints ~100-700 inline `<span>` elements per pane.

### Dual rendering paths create maintenance burden

Every rendering change (new ANSI attributes, cursor modes, OSC protocols) would need to be implemented in both the canvas drawing code and TerminalLine.tsx. This doubles the surface area for rendering bugs.

### Canvas text rendering is worse for terminals

- Canvas uses different font hinting/subpixel antialiasing than native DOM text
- Terminal users are sensitive to font rendering quality
- CJK/emoji rendering requires manual width calculations on canvas (DOM handles it natively)
- OSC 8 hyperlinks can't be clickable on canvas

## When Canvas Would Make Sense

Canvas terminal rendering is appropriate when:
- The DOM layer can be **fully replaced** (no test dependency on DOM text queries)
- The app is a **standalone terminal emulator** (like xterm.js) doing its own ANSI parsing
- There are **thousands of rapidly changing cells** overwhelming DOM reconciliation
- The hidden DOM layer is only needed for accessibility (screen reader text), not for test infrastructure

## Summary

For a tmux frontend that receives pre-parsed cells at 60fps max and has extensive E2E tests relying on DOM queries, the existing span-based rendering with memoization is the right approach. Canvas adds complexity and a second rendering path without removing any existing work.
