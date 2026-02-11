# Remove Local Preview State for Resize and Drag Operations

**Status**: Completed
**Date**: 2026-01-15

## Overview

Currently, resize and drag operations maintain local preview state that simulates the visual effect before sending commands to tmux. This creates complexity and potential sync issues. The goal is to send real tmux commands immediately when the user crosses a resize/swap threshold, eliminating local preview state.

## Current Architecture

### Resize Flow (current)
1. `RESIZE_START` → initialize `resize` state with start position
2. `RESIZE_MOVE` → calculate pixel delta, convert to rows/cols, call `computeResizePreview()` to create local `previewPanes`
3. `RESIZE_END` → send `resize-pane` command to tmux, enter `committing` state
4. `UPDATE_PANES` (from tmux) → verify change, exit to `idle`

### Drag Flow (current)
1. `DRAG_START` → initialize `drag` state with start position
2. `DRAG_MOVE` → calculate mouse position, find swap target via `findSwapTarget()`, call `computeDragPreview()`
3. `DRAG_END` → send `swap-pane` command to tmux, enter `committing` state
4. `UPDATE_PANES` (from tmux) → verify change, exit to `idle`

## New Architecture

### Resize Flow (new)
1. `RESIZE_START` → initialize resize tracking (start position, last sent delta)
2. `RESIZE_MOVE` → calculate delta in rows/cols, if changed from last sent → send `resize-pane` immediately
3. `RESIZE_END` → clear resize state
4. No preview state needed - UI always shows actual tmux state

### Drag Flow (new)
1. `DRAG_START` → initialize drag tracking (dragged pane, visual offset)
2. `DRAG_MOVE` → find swap target, if target changed → send `swap-pane` immediately
3. `DRAG_END` → clear drag state
4. Dragged pane still follows cursor visually (CSS transform), but actual swap happens immediately

## Key Changes

### resizeMachine.ts
- Remove `previewPanes` from context
- Remove `computeResizePreview` usage
- Track `lastSentDelta: { cols: number, rows: number }` to avoid duplicate commands
- Send `resize-pane` command on each `RESIZE_MOVE` when delta changes
- Remove `committing` state entirely
- Remove `notifyPreviewUpdate` action

### dragMachine.ts
- Remove `previewPanes` from context
- Remove `computeDragPreview` usage
- Track `lastTargetPaneId` to avoid duplicate swap commands
- Send `swap-pane` command on each `DRAG_MOVE` when target changes
- Keep visual drag offset (currentX/Y - startX/Y) for CSS transform
- Remove `committing` state entirely
- Remove `notifyPreviewUpdate` action

### appMachine.ts
- Remove `DRAG_PREVIEW_UPDATE` and `RESIZE_PREVIEW_UPDATE` handlers
- Remove `DRAG_COMMIT_START`, `RESIZE_COMMIT_START` handlers
- Remove `isDragCommitting`, `isResizeCommitting` from context
- Keep `drag` and `resize` state for visual tracking only
- `previewPanes` simply equals `panes` always (or remove entirely)

### PaneLayout.tsx
- Remove `isCommitting` logic
- Dragged pane still uses CSS transform to follow cursor
- Other panes animate based on actual tmux positions

### helpers.ts files
- `computeResizePreview` - DELETE
- `computeDragPreview` - DELETE
- `findSwapTarget` - KEEP (needed to determine when to send swap command)

## Implementation Steps

1. **Simplify resizeMachine**
   - Remove preview state
   - Send command on delta change
   - Remove committing state

2. **Simplify dragMachine**
   - Remove preview state
   - Send swap on target change
   - Keep drag offset for visual

3. **Update appMachine**
   - Remove preview-related events
   - Simplify context

4. **Update PaneLayout**
   - Remove committing-related logic

5. **Clean up helpers**
   - Remove unused preview computation functions

## Benefits

1. **Simpler state management** - No parallel preview state to maintain
2. **Always synchronized** - UI reflects actual tmux state
3. **Faster feedback** - User sees real changes immediately
4. **Less code** - Remove preview computation logic
5. **No edge cases** - No need to handle commit timeouts or stale data

## Risks & Mitigations

1. **Latency** - Real commands may be slower than local preview
   - Mitigation: tmux commands are fast (<50ms), should be imperceptible

2. **Command flooding** - Rapid movements could flood tmux
   - Mitigation: Track last sent value, only send when threshold crossed (1 char)

3. **Race conditions** - Multiple commands in flight
   - Mitigation: tmux handles commands sequentially, state updates will arrive in order

## Results

Implementation completed on 2026-01-15.

### Changes Made

1. **resizeMachine.ts** - Simplified to send `resize-pane` commands immediately when delta crosses character threshold
   - Added `lastSentDelta` tracking to ResizeState type
   - Removed `previewPanes` from context
   - Removed `committing` state
   - Uses `enqueueActions` to conditionally send commands

2. **dragMachine.ts** - Simplified to send `swap-pane` commands immediately when target changes
   - Added `lastSwappedTargetId` tracking to DragState type
   - Removed `previewPanes` from context
   - Removed `committing` state
   - Uses `enqueueActions` to conditionally send commands

3. **appMachine.ts** - Removed preview-related events and context
   - Removed `previewPanes`, `isDragCommitting`, `isResizeCommitting` from context
   - Replaced `DRAG_PREVIEW_UPDATE` with `DRAG_STATE_UPDATE`
   - Replaced `RESIZE_PREVIEW_UPDATE` with `RESIZE_STATE_UPDATE`
   - Removed `DRAG_COMMIT_START`, `RESIZE_COMMIT_START` handlers

4. **types.ts** - Updated types
   - Added `lastSentDelta` to `ResizeState`
   - Added `lastSwappedTargetId` to `DragState`
   - Removed `previewPanes` from machine contexts
   - Updated parent event types

5. **selectors.ts** - `selectPreviewPanes` now returns `context.panes` directly

6. **AppContext.tsx** - `useIsCommittingDrag` and `useIsCommittingResize` now return `false`

7. **PaneLayout.tsx** - Removed `isCommitting` logic and unused imports

8. **helpers.ts** - Removed `computeDragPreview` and `computeResizePreview` functions

### Verification

- [x] TypeScript compiles without errors
- [x] Dev server starts successfully
- [x] Code complexity reduced (removed ~200 lines of preview computation)
- [x] Resize sends real-time tmux commands on threshold crossing
- [x] Drag sends real-time swap commands on target change
- [x] **Resize tested in browser** - Verified working! Dragging divider immediately resizes panes without local preview flickering
- [ ] **Drag-to-swap** - Browser automation couldn't reliably target pane header. Manual testing recommended.

### Notes

Browser testing on 2026-01-15:
- **Resize: VERIFIED** - Created vertical split, dragged divider left/right. Panes resize immediately with no flickering. Real tmux commands sent on threshold crossing.
- **Drag-to-swap: INCONCLUSIVE** - Mouse automation couldn't precisely target header's draggable area (excludes buttons). Manual testing recommended to verify swap functionality.
