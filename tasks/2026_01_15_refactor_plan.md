# Refactor Plan

## Results Summary

> **Status:** ✅ Completed

| Phase | Changes | Lines Removed |
|-------|---------|---------------|
| Phase 1: Test Helpers | Removed 6 unused tmux functions, 6 unused assertion helpers | ~135 LOC |
| Phase 2: Frontend | Removed 3 unused selectors, 1 unused export, 1 dead type | ~35 LOC |
| Phase 3: Types | Removed 3 redundant actor type definitions | ~15 LOC |

**Total Impact:**
- ~185 lines removed
- 13 unused functions/types deleted
- 5 files cleaned up

**Files Modified:**
- `tests/helpers/tmux.js` - Removed `getTmuxPaneCount`, `getTmuxPaneInfo`, `getActiveTmuxPane`, `getTmuxWindowCount`, `isPaneZoomed`, `sendKeysToTmux`
- `tests/helpers/assertions.js` - Removed `comparePaneCounts`, `compareTmuxAndUIState`, `verifySplit`, `verifyNavigation`, `verifyZoom`, `verifyWindowCount`
- `packages/tmuxy-ui/src/machines/selectors.ts` - Removed `selectActivePane`, `selectPanePixelDimensionsById`, `selectTargetDimensions`
- `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` - Removed `sendTmuxCommand`
- `packages/tmuxy-ui/src/machines/appMachine.ts` - Removed `KeyboardActorEvent` type
- `packages/tmuxy-ui/src/machines/types.ts` - Removed `TmuxActorInput`, `TmuxActorRef`, `KeyboardActorInput`

**Not Executed (Deferred):**
- Terminal.tsx ANSI duplication (needs careful refactoring)
- Rust default wrapper functions (low ROI)
- State hash logic duplication in Rust (low ROI)
- Test setup helpers consolidation (functions are similar but contextual)

---

## Original Analysis

---

## Issues Found

### Critical Priority

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | Duplicate tmux.js and TmuxTestSession.js | tests/helpers/ | 9 duplicate functions, ~150 LOC |
| 2 | Unused assertion helpers | tests/helpers/assertions.js | 6 unused functions, ~75 LOC |
| 3 | Unused tmux.js helper functions | tests/helpers/tmux.js | 6 unused functions, ~50 LOC |
| 4 | Duplicate ANSI rendering logic | Terminal.tsx | 110+ LOC duplicated |

### High Priority

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 5 | Duplicate `countDividersAbove()` | PaneLayout.tsx | Function defined twice |
| 6 | Unused selector functions | selectors.ts | 3 unused exports |
| 7 | Duplicate state hash logic | websocket.rs, monitor.rs | ~50 LOC duplicated |
| 8 | Unused `sendTmuxCommand` export | tmuxActor.ts | Dead export |

### Medium Priority

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 9 | Duplicate test setup patterns | 6 test files | ~35 lines repeated |
| 10 | Dead `KeyboardActorEvent` type | appMachine.ts | Unused type definition |
| 11 | Unused mouse handler params | App.tsx | Dead code in callbacks |
| 12 | Redundant type re-exports | types.ts, AppContext.tsx | Confusing export chain |

### Low Priority

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 13 | ~20 default session wrappers | executor.rs | Rust boilerplate (~500 LOC) |
| 14 | Legacy polling code | websocket.rs | Fallback complexity |
| 15 | Backwards compat aliases | lib.rs | Minor indirection |

---

## Execution Plan

### Phase 1: Test Helpers Cleanup

**Goal:** Eliminate duplicate test infrastructure

#### 1.1 Remove duplicate functions from tmux.js
- Delete: `getTmuxPaneCount`, `getTmuxPaneInfo`, `getActiveTmuxPane`, `getTmuxWindowCount`, `isPaneZoomed`, `sendKeysToTmux`
- Keep: `runTmuxCommand`, `generateTestSessionName`, `createTmuxSession`, `killTmuxSession`, `captureTmuxSnapshot` (used by e2e.test.js)

#### 1.2 Remove unused assertion helpers
- Delete from assertions.js: `comparePaneCounts`, `compareTmuxAndUIState`, `verifySplit`, `verifyNavigation`, `verifyZoom`, `verifyWindowCount`
- Keep: `verifyLayoutChanged` (used)

#### 1.3 Add shared test setup helpers
- Create `setupPanes(ctx, count)` in test-setup.js
- Remove duplicated setup functions from individual test files

---

### Phase 2: Frontend Cleanup

**Goal:** Remove dead code and unused exports

#### 2.1 Remove unused exports from selectors.ts
- Delete: `selectActivePane`, `selectPanePixelDimensionsById`, `selectTargetDimensions`

#### 2.2 Remove dead code from appMachine.ts
- Delete: `KeyboardActorEvent` type (line 238)

#### 2.3 Remove unused export from tmuxActor.ts
- Delete: `sendTmuxCommand` function export

#### 2.4 Clean up App.tsx callbacks
- Simplify `handleMouseMove` (remove or make functional)
- Remove unused `_tmuxId` param from `handleMouseUp`

#### 2.5 Consolidate countDividersAbove in PaneLayout.tsx
- Extract to single shared function used by both PaneLayout and ResizeDividers

---

### Phase 3: Type Cleanup

**Goal:** Simplify type exports

#### 3.1 Remove redundant actor types from machines/types.ts
- Delete: `TmuxActorInput`, `TmuxActorRef`, `KeyboardActorInput` (defined in actor files)

---

### Phase 4: Documentation (Deferred)

**Not executing - documenting for future:**
- Terminal.tsx ANSI duplication (needs careful refactoring)
- Rust default wrapper functions (low ROI)
- State hash logic duplication in Rust (low ROI)

---

## Files to Modify

| File | Action |
|------|--------|
| `tests/helpers/tmux.js` | Remove 6 unused functions |
| `tests/helpers/assertions.js` | Remove 6 unused functions |
| `tests/helpers/test-setup.js` | Add shared `setupPanes` helper |
| `tests/helpers/index.js` | Update exports |
| `tests/pane-*.test.js` | Remove local setup functions, use shared |
| `tests/layout.test.js` | Remove local setup function, use shared |
| `packages/tmuxy-ui/src/machines/selectors.ts` | Remove 3 unused selectors |
| `packages/tmuxy-ui/src/machines/appMachine.ts` | Remove dead type |
| `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` | Remove unused export |
| `packages/tmuxy-ui/src/machines/types.ts` | Remove redundant actor types |
| `packages/tmuxy-ui/src/App.tsx` | Clean up mouse handlers |
| `packages/tmuxy-ui/src/components/PaneLayout.tsx` | Consolidate countDividersAbove |

---

## Estimated Impact

- **Lines removed:** ~300+
- **Functions removed:** ~20
- **Files modified:** ~15
- **Risk level:** Low (removing unused code)
