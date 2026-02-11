# Tmuxy UI Refactor Plan

## Completed Refactoring

### 1. Terminal.tsx ANSI Duplication (COMPLETED)

**Problem:** ~110 lines of duplicate ANSI rendering code - the same styling logic was repeated for line segments and cursor rendering.

**Solution:** Extracted shared functions:
- `buildAnsiStyle(part: AnserJsonEntry): React.CSSProperties` - Build CSS from Anser entry
- `renderAnsiPart(...)` - Render individual ANSI segment with cursor support
- `renderEndOfLineCursor(...)` - Render cursor at end of line

**Result:** Eliminated duplicate code, improved maintainability.

### 2. Rust Deferred Items (ANALYZED - No Changes Needed)

After analysis, determined these are intentional design choices:

- **Default session wrapper functions (~15):** These are API convenience methods providing cleaner interface for external callers. Keeping them is correct.

- **State hash logic (appears twice):** These are two different monitoring approaches:
  - `state_hash` field: Used for efficient polling comparison
  - Control mode hash: Separate tracking for control mode events
  - Not actual duplication.

- **Backwards compatibility aliases:** Only 7 lines, serves useful purpose for API stability.

### 3. Test Setup Helper Consolidation (COMPLETED)

**Problem:** Multiple test files had duplicate setup functions (`setupPanes`, `setupTwoPanes`, `setupFourPanes`).

**Solution:** Added shared helpers to `/workspace/tests/helpers/test-setup.js`:
```javascript
ctx.setupPanes = async (count = 3) => { ... };
ctx.setupTwoPanes = async (direction = 'horizontal') => { ... };
ctx.setupFourPanes = async () => { ... };
```

**Files Updated:**
- `tests/layout.test.js` - Uses `ctx.setupPanes()`
- `tests/pane-close.test.js` - Uses `ctx.setupPanes()`
- `tests/pane-resize.test.js` - Uses `ctx.setupTwoPanes()`
- `tests/pane-navigate.test.js` - Uses `ctx.setupTwoPanes()`, `ctx.setupFourPanes()`
- `tests/pane-swap.test.js` - Uses `ctx.setupTwoPanes()`

---

### 4. State Machine Refactoring - Option B (COMPLETED)

Split the monolithic `appMachine.ts` (~1033 lines) into focused child machines.

#### New File Structure

```
src/machines/
├── appMachine.ts          # Parent orchestrator (~430 lines)
├── keyboardMachine.ts     # Keyboard input modes (normal/prefix/command) (~170 lines)
├── dragMachine.ts         # Pane drag-to-swap operations (~210 lines)
├── resizeMachine.ts       # Pane resize operations (~200 lines)
├── helpers.ts             # Shared helper functions (~250 lines)
├── types.ts               # Type definitions (unchanged)
├── AppContext.tsx         # React context (updated for new architecture)
└── actors/
    ├── tmuxActor.ts       # Tmux backend communication (~65 lines)
    └── keyboardActor.ts   # Key mapping utilities (unchanged)
```

#### Implementation Details

**helpers.ts** - Extracted helper functions:
- `camelize<T>()` - Convert snake_case to camelCase
- `transformServerState()` - Transform server state to client format
- `buildStacksFromWindows()` - Build pane stacks from window names
- `computeDragPreview()` - Compute preview panes during drag
- `findSwapTarget()` - Find swap target pane from mouse position
- `computeResizePreview()` - Compute preview panes during resize

**keyboardMachine.ts** - Handles keyboard input modes:
- States: `normal`, `prefixWait`, `commandMode`
- Sends `SEND_TMUX_COMMAND` events to parent
- Manages prefix timeout and command input

**dragMachine.ts** - Handles pane drag-to-swap:
- States: `idle`, `dragging`, `committing`
- Computes drag preview in real-time
- Sends swap commands to parent on drop

**resizeMachine.ts** - Handles pane resize:
- States: `idle`, `resizing`, `committing`
- Computes resize preview in real-time
- Sends resize commands to parent on release

**appMachine.ts** - Parent orchestrator:
- States: `connecting`, `idle`
- Invokes all child machines and actors
- Forwards events between children and tmux actor
- Handles stack operations and UI config

**AppContext.tsx** - Updated hooks:
- `useIsDragging()` - Now checks `context.drag !== null`
- `useIsResizing()` - Now checks `context.resize !== null`
- Removed state-based matching for child machine states

#### Benefits Achieved

1. **Separation of concerns** - Each machine handles one feature
2. **Testability** - Child machines can be unit tested independently
3. **Maintainability** - Smaller files are easier to understand and modify
4. **Extensibility** - New features can be added as new machines

#### Line Count Reduction

| File | Before | After |
|------|--------|-------|
| appMachine.ts | 1033 | ~430 |
| keyboardMachine.ts | - | ~170 |
| dragMachine.ts | - | ~210 |
| resizeMachine.ts | - | ~200 |
| helpers.ts | - | ~250 |
| **Total** | 1033 | ~1260 |

Note: Total lines increased slightly due to additional structure, type definitions, and documentation, but each individual file is now focused and manageable.

---

## Test Status Notes

Pre-existing test failures in `Terminal.test.tsx`:
- Tests mock `@xterm/xterm` but component uses Anser-based rendering
- These failures are NOT related to refactoring work
- Fix would require updating test mocks to match actual component behavior

---

## Summary

| Item | Status | Impact |
|------|--------|--------|
| Terminal.tsx ANSI duplication | ✅ Done | ~110 LOC reduced |
| Rust deferred items | ✅ Analyzed | No changes needed |
| Test setup consolidation | ✅ Done | 5 files cleaned |
| State machine refactoring (Option B) | ✅ Done | Split into 5 focused modules |

## Build Status

✅ TypeScript compilation: **PASSED**
✅ Vite build: **PASSED** (built in 2.51s)
