# Refactor Summary: Component Cleanup and Code Organization

**Date:** 2026-01-13
**Status:** Completed
**Tests:** 9/9 passing

## Overview

This refactor focused on cleaning up the tmuxy-ui codebase by:
- Extracting shared utilities from components
- Creating a constants file for layout values
- Removing unused props
- Improving code organization

## Changes Made

### 1. Extracted ANSI Style Utility

**New file:** `src/utils/ansiStyles.ts`

Extracted the duplicate `buildAnsiStyle` function from both `Terminal.tsx` and `TmuxStatusBar.tsx` into a shared utility.

```typescript
export function buildAnsiStyle(part: AnserJsonEntry): React.CSSProperties
```

**Files updated:**
- `src/components/Terminal.tsx` - now imports from `../utils/ansiStyles`
- `src/components/TmuxStatusBar.tsx` - now imports from `../utils/ansiStyles`

### 2. Extracted ResizeDividers Component

**New file:** `src/components/ResizeDividers.tsx`

Extracted the `ResizeDividers` component and its helper functions from `PaneLayout.tsx` into a dedicated file (~200 lines).

Helper functions moved:
- `mergeSegments()` - Merges adjacent/overlapping divider segments
- `countDividersAbove()` - Counts horizontal divider rows above a position
- `collectDividerSegments()` - Collects divider segments from pane layout

**Files updated:**
- `src/components/PaneLayout.tsx` - reduced from ~548 lines to ~330 lines

### 3. Created Layout Constants

**New files:**
- `src/constants/layout.ts`
- `src/constants/index.ts`

Centralized layout constants that were duplicated across files:

```typescript
export const CHAR_WIDTH = 9.6;
export const CHAR_HEIGHT = 20;
export const PANE_GAP = 2;
export const CONTAINER_GAP = 8;
export const HALF_GAP = PANE_GAP / 2;
export const STATUS_BAR_HEIGHT = 33;
```

**Files updated:**
- `src/App.tsx` - imports from `./constants`
- `src/components/PaneLayout.tsx` - imports from `../constants`
- `src/components/ResizeDividers.tsx` - imports from `../constants`

### 4. Added Stack Selector

**File:** `src/machines/selectors.ts`

Added `selectStackPanes()` selector for getting all panes in a stack:

```typescript
export function selectStackPanes(
  context: AppMachineContext,
  stack: PaneStack
): TmuxPane[]
```

### 5. Removed Unused Props

**File:** `src/App.tsx`

Removed unused `paneId` prop being passed to `Terminal` component.

### 6. Consolidated Duplicate Constants

**File:** `src/machines/constants.ts`

Removed duplicate `STATUS_BAR_HEIGHT` constant (was defined in both `machines/constants.ts` and `constants/layout.ts`).

**File:** `src/machines/drag/dragMachine.ts`

Updated import to use `STATUS_BAR_HEIGHT` from `../../constants` (layout) instead of `../constants` (machines).

### 7. Fixed HALF_GAP Naming Confusion

**File:** `src/App.tsx`

Renamed local `HALF_GAP` constant to `CONTAINER_PADDING` to avoid confusion with the different `HALF_GAP` in layout constants:
- `HALF_GAP` in layout = `PANE_GAP / 2 = 1px` (half of pane gap)
- `CONTAINER_PADDING` in App = `CONTAINER_GAP / 2 = 4px` (container padding)

### 8. Removed Unused paneIndex Prop

**File:** `src/components/PaneHeader.tsx`

Removed unused `paneIndex` prop from interface and component destructuring.

**File:** `src/App.tsx`

Removed `paneIndex={pane.id}` prop being passed to `PaneHeader` component.

## Test Results

All 9 tests pass:
- `src/test/Terminal.test.tsx` (7 tests)
- `src/test/App.test.tsx` (2 tests)

## File Structure After Refactor

```
src/
├── constants/
│   ├── index.ts          # NEW - barrel export
│   └── layout.ts         # NEW - layout constants (STATUS_BAR_HEIGHT, CHAR_*, etc.)
├── utils/
│   ├── ansiStyles.ts     # NEW - ANSI style builder
│   └── richContentParser.ts
├── components/
│   ├── PaneHeader.tsx    # UPDATED - removed unused paneIndex prop
│   ├── PaneLayout.tsx    # SIMPLIFIED - removed ~200 lines
│   ├── ResizeDividers.tsx # NEW - extracted from PaneLayout
│   ├── Terminal.tsx      # UPDATED - uses shared utility
│   └── TmuxStatusBar.tsx # UPDATED - uses shared utility
├── machines/
│   ├── constants.ts      # UPDATED - removed duplicate STATUS_BAR_HEIGHT
│   ├── drag/
│   │   └── dragMachine.ts # UPDATED - imports STATUS_BAR_HEIGHT from layout
│   └── selectors.ts      # UPDATED - added selectStackPanes
└── App.tsx               # UPDATED - renamed HALF_GAP to CONTAINER_PADDING
```

## Notes

- The `useIsPrefixMode()` hook in `AppContext.tsx` always returns `false` - this is documented in the code as a known limitation where keyboard machine state is internal to its actor
- Stack helper functions remain in `App.tsx` as `useCallback` wrappers since they're used inside render callbacks where hooks cannot be called directly
