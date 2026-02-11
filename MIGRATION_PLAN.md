# Migration Plan: Framer Motion to Anime.js

## Executive Summary

Replace `framer-motion` with `animejs` for pane layout animations. The migration focuses on using Anime.js's **Layout API** for position animations while keeping the existing state machine architecture for drag/resize logic.

**Key Decision: No Anime.js Draggable API**

After researching the Draggable API, the recommendation is to **NOT use it**. The current custom drag implementation via `dragMachine.ts` is well-designed and provides:
- Real-time swap commands to tmux
- Stable visual tracking during swaps
- Integration with keyboard cancellation (Escape)
- Drop target detection and preview

The Draggable API would add complexity without benefit. Instead, we'll use:
- **Layout API** for animating pane position changes
- **Existing drag state machine** for tracking mouse position and calculating swaps
- **Direct DOM manipulation** via pane IDs for imperative animations

---

## Current State Analysis

### Framer Motion Usage (Single File)

**File:** `packages/tmuxy-ui/src/components/PaneLayout.tsx`

```tsx
import { motion, AnimatePresence } from 'framer-motion';

// Used for:
// 1. motion.div - Animated pane wrapper
// 2. AnimatePresence - Mount/unmount transitions
// 3. animate prop - Position/size animations
// 4. transition prop - Spring/tween config
```

**Animation Properties:**
- `x`, `y` - Drag offset (follows cursor)
- `left`, `top`, `width`, `height` - Layout position
- `zIndex` - Elevation during drag

**Transition Configs:**
- During drag/resize: `{ type: 'tween', duration: 0 }` (instant)
- Normal state: `{ type: 'spring', stiffness: 400, damping: 30, mass: 0.8 }`

### Current Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      appMachine.ts                          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ dragMachine │  │ resizeMachine │  │ keyboardMachine │    │
│  └─────────────┘  └──────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      PaneLayout.tsx                         │
│  - Reads state via selectors                                │
│  - Renders motion.div per pane                              │
│  - Framer handles position animation                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      appMachine.ts                          │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ dragMachine │  │ resizeMachine │  │ keyboardMachine │    │
│  └──────┬──────┘  └──────────────┘  └─────────────────┘    │
│         │ (emit animation events)                           │
└─────────┼───────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│               useLayoutAnimation.ts (new hook)              │
│  - Creates Anime.js Layout instance                         │
│  - Listens for drag/resize state changes                    │
│  - Calls layout.record() / layout.animate()                 │
│  - Manages placeholder/shadow element                       │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│                      PaneLayout.tsx                         │
│  - Renders plain div per pane (no motion.div)               │
│  - Uses data-pane-id for DOM access                         │
│  - CSS handles transitions when not animating               │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Setup & Infrastructure

#### 1.1 Install Anime.js

```bash
npm install animejs@^4.3.0 --save
npm uninstall framer-motion
```

#### 1.2 Create Animation Scope Hook

**New file:** `packages/tmuxy-ui/src/hooks/useAnimeScope.ts`

```tsx
import { useRef, useEffect } from 'react';
import { createScope, Scope } from 'animejs';

export function useAnimeScope<T extends HTMLElement>(): {
  rootRef: React.RefObject<T>;
  scope: React.MutableRefObject<Scope | null>;
} {
  const rootRef = useRef<T>(null);
  const scope = useRef<Scope | null>(null);

  useEffect(() => {
    if (!rootRef.current) return;

    scope.current = createScope({ root: rootRef.current });

    return () => {
      scope.current?.revert();
      scope.current = null;
    };
  }, []);

  return { rootRef, scope };
}
```

#### 1.3 Create Layout Animation Hook

**New file:** `packages/tmuxy-ui/src/hooks/useLayoutAnimation.ts`

This hook encapsulates all Anime.js Layout API interactions:

```tsx
import { useRef, useEffect, useCallback } from 'react';
import { createLayout, createScope, animate } from 'animejs';
import type { AutoLayout, Scope } from 'animejs';

interface LayoutAnimationOptions {
  rootRef: React.RefObject<HTMLElement>;
  isDragging: boolean;
  isResizing: boolean;
  draggedPaneId: string | null;
  onLayoutReady?: () => void;
}

interface LayoutAnimationResult {
  animateToNewPositions: () => void;
  setDraggedPaneTransform: (x: number, y: number) => void;
  showPlaceholder: (paneId: string) => void;
  hidePlaceholder: () => void;
}

export function useLayoutAnimation({
  rootRef,
  isDragging,
  isResizing,
  draggedPaneId,
  onLayoutReady,
}: LayoutAnimationOptions): LayoutAnimationResult {
  const layoutRef = useRef<AutoLayout | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  const placeholderRef = useRef<HTMLElement | null>(null);

  // Initialize layout on mount
  useEffect(() => {
    if (!rootRef.current) return;

    scopeRef.current = createScope({ root: rootRef.current });

    layoutRef.current = createLayout(rootRef.current, {
      children: '[data-pane-id]',
      duration: 300,
      ease: 'out(3)', // Equivalent to spring feel
      // Only animate position properties, not size during drag
      properties: ['left', 'top', 'width', 'height'],
    });

    onLayoutReady?.();

    return () => {
      layoutRef.current?.revert();
      scopeRef.current?.revert();
    };
  }, []);

  // Animate panes to new positions (after swap or resize)
  const animateToNewPositions = useCallback(() => {
    if (!layoutRef.current || isDragging || isResizing) return;

    layoutRef.current.record();
    // DOM changes happen via React re-render
    requestAnimationFrame(() => {
      layoutRef.current?.animate();
    });
  }, [isDragging, isResizing]);

  // Directly transform dragged pane (no React re-render)
  const setDraggedPaneTransform = useCallback((x: number, y: number) => {
    if (!draggedPaneId) return;

    const paneEl = document.querySelector(`[data-pane-id="${draggedPaneId}"]`) as HTMLElement;
    if (paneEl) {
      paneEl.style.transform = `translate(${x}px, ${y}px)`;
      paneEl.style.zIndex = '100';
    }
  }, [draggedPaneId]);

  // Show placeholder at pane's original position
  const showPlaceholder = useCallback((paneId: string) => {
    const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement;
    if (!paneEl || !rootRef.current) return;

    // Create placeholder if not exists
    if (!placeholderRef.current) {
      placeholderRef.current = document.createElement('div');
      placeholderRef.current.className = 'pane-drag-placeholder';
      rootRef.current.appendChild(placeholderRef.current);
    }

    // Position placeholder at pane's current CSS position
    const style = window.getComputedStyle(paneEl);
    placeholderRef.current.style.cssText = `
      position: absolute;
      left: ${style.left};
      top: ${style.top};
      width: ${style.width};
      height: ${style.height};
      pointer-events: none;
    `;
  }, [rootRef]);

  // Hide and animate placeholder to new position
  const hidePlaceholder = useCallback(() => {
    if (placeholderRef.current) {
      // Animate placeholder fade out
      animate(placeholderRef.current, {
        opacity: 0,
        duration: 200,
        onComplete: () => {
          placeholderRef.current?.remove();
          placeholderRef.current = null;
        },
      });
    }
  }, []);

  return {
    animateToNewPositions,
    setDraggedPaneTransform,
    showPlaceholder,
    hidePlaceholder,
  };
}
```

---

### Phase 2: Pane Layout Migration

#### 2.1 Update PaneLayout.tsx

Remove Framer Motion, use plain divs with data attributes:

```tsx
import React, { useCallback, useRef, useMemo, useEffect } from 'react';
import { useLayoutAnimation } from '../hooks/useLayoutAnimation';
import {
  useAppSelector,
  useAppSend,
  useIsDragging,
  useIsResizing,
  selectVisiblePanes,
  selectDraggedPaneId,
  selectDragTargetPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectDragOriginalPosition,
  selectGridDimensions,
  selectDropTarget,
} from '../machines/AppContext';
import { Pane } from './Pane';
import { ResizeDividers } from './ResizeDividers';
import type { TmuxPane } from '../machines/types';
import { PANE_GAP, HALF_GAP, PANE_HEADER_HEIGHT, PANE_INSET } from '../constants';
import { useContainerSize, useGlobalMouseEvents } from '../hooks';

export function PaneLayout() {
  const send = useAppSend();
  const containerRef = useRef<HTMLDivElement>(null);

  // State selectors
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const draggedPaneId = useAppSelector(selectDraggedPaneId);
  const dragTargetPaneId = useAppSelector(selectDragTargetPaneId);
  const dropTarget = useAppSelector(selectDropTarget);
  const { charWidth, charHeight, totalWidth, totalHeight } = useAppSelector(selectGridDimensions);
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const dragOriginalPosition = useAppSelector(selectDragOriginalPosition);

  const isDragging = useIsDragging();
  const isResizing = useIsResizing();

  // Layout animation hook
  const {
    animateToNewPositions,
    setDraggedPaneTransform,
    showPlaceholder,
    hidePlaceholder,
  } = useLayoutAnimation({
    rootRef: containerRef,
    isDragging,
    isResizing,
    draggedPaneId,
  });

  // Handle global mouse events
  const containerSize = useContainerSize(containerRef);
  useGlobalMouseEvents(isDragging, isResizing, send);

  // Calculate center offset
  const contentWidth = totalWidth * charWidth;
  const contentHeight = totalHeight * charHeight;
  const centerOffsetX = Math.max(0, (containerSize.width - contentWidth) / 2);
  const centerOffsetY = Math.max(0, (containerSize.height - contentHeight) / 2);

  // Update dragged pane transform on drag move (no React re-render)
  useEffect(() => {
    if (isDragging && draggedPaneId) {
      setDraggedPaneTransform(dragOffsetX, dragOffsetY);
    }
  }, [isDragging, draggedPaneId, dragOffsetX, dragOffsetY, setDraggedPaneTransform]);

  // Show placeholder when drag starts
  useEffect(() => {
    if (isDragging && draggedPaneId) {
      showPlaceholder(draggedPaneId);
    } else {
      hidePlaceholder();
    }
  }, [isDragging, draggedPaneId, showPlaceholder, hidePlaceholder]);

  // Animate layout changes when panes change (not during drag/resize)
  const prevPanesRef = useRef(visiblePanes);
  useEffect(() => {
    if (!isDragging && !isResizing && prevPanesRef.current !== visiblePanes) {
      animateToNewPositions();
    }
    prevPanesRef.current = visiblePanes;
  }, [visiblePanes, isDragging, isResizing, animateToNewPositions]);

  // Compute pane style
  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      const isDraggedPane = draggedPaneId && pane.tmuxId === draggedPaneId;
      const useOriginal = isDraggedPane && isDragging && dragOriginalPosition;

      const x = useOriginal ? dragOriginalPosition.x : pane.x;
      const y = useOriginal ? dragOriginalPosition.y : pane.y;
      const width = useOriginal ? dragOriginalPosition.width : pane.width;
      const height = useOriginal ? dragOriginalPosition.height : pane.height;

      return {
        position: 'absolute',
        left: centerOffsetX + x * charWidth + HALF_GAP - PANE_INSET,
        top: centerOffsetY + y * charHeight + HALF_GAP - PANE_INSET,
        width: width * charWidth - PANE_GAP + 2 * PANE_INSET,
        height: height * charHeight + PANE_HEADER_HEIGHT - PANE_GAP + 2 * PANE_INSET,
      };
    },
    [charWidth, charHeight, centerOffsetX, centerOffsetY, draggedPaneId, isDragging, dragOriginalPosition]
  );

  // Get CSS class for pane
  const getPaneClassName = useCallback(
    (pane: TmuxPane): string => {
      const classes = ['pane-layout-item'];
      if (pane.active) classes.push('pane-active');
      else classes.push('pane-inactive');
      if (pane.inMode) classes.push('pane-copy-mode');
      if (pane.tmuxId === draggedPaneId) classes.push('pane-dragging');
      if (pane.tmuxId === dragTargetPaneId) classes.push('pane-drop-target');
      return classes.join(' ');
    },
    [draggedPaneId, dragTargetPaneId]
  );

  // Single pane - no animation needed
  if (visiblePanes.length === 1) {
    return (
      <div
        className="pane-layout-single"
        data-pane-id={visiblePanes[0].tmuxId}
        style={{ margin: HALF_GAP }}
      >
        <Pane paneId={visiblePanes[0].tmuxId} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing ? 'pane-layout-resizing' : ''}`}
    >
      {visiblePanes.map((pane) => (
        <div
          key={pane.tmuxId}
          data-pane-id={pane.tmuxId}
          className={getPaneClassName(pane)}
          style={getPaneStyle(pane)}
        >
          <Pane paneId={pane.tmuxId} />
        </div>
      ))}

      {/* Drop target indicator */}
      {dropTarget && (
        <div
          className="drop-target-indicator"
          style={{
            position: 'absolute',
            left: centerOffsetX + dropTarget.x * charWidth + HALF_GAP - PANE_INSET,
            top: centerOffsetY + dropTarget.y * charHeight + HALF_GAP - PANE_INSET,
            width: dropTarget.width * charWidth - PANE_GAP + 2 * PANE_INSET,
            height: dropTarget.height * charHeight + PANE_HEADER_HEIGHT - PANE_GAP + 2 * PANE_INSET,
          }}
        />
      )}

      <ResizeDividers centerOffsetX={centerOffsetX} centerOffsetY={centerOffsetY} />
    </div>
  );
}
```

---

### Phase 3: State Machine Integration

#### 3.1 Add Animation Events to Drag Machine

Update `dragMachine.ts` to emit events that the animation hook can listen to:

```tsx
// Add to actions
emitAnimationEvent: sendParent(({ context }) => ({
  type: 'ANIMATION_EVENT' as const,
  event: 'DRAG_POSITION_UPDATE',
  data: {
    paneId: context.drag?.draggedPaneId,
    offsetX: context.drag ? context.drag.currentX - context.drag.startX : 0,
    offsetY: context.drag ? context.drag.currentY - context.drag.startY : 0,
  },
})),
```

This allows the animation system to receive position updates directly from the state machine rather than through React re-renders.

#### 3.2 Create Animation Actor (Optional Enhancement)

For better separation of concerns, create a dedicated animation actor:

**New file:** `packages/tmuxy-ui/src/machines/animation/animationActor.ts`

```tsx
import { fromCallback } from 'xstate';
import { createLayout, animate } from 'animejs';

export const animationActor = fromCallback(({ sendBack, receive }) => {
  let layout: AutoLayout | null = null;
  let rootElement: HTMLElement | null = null;

  // Initialize when root element is ready
  const init = (root: HTMLElement) => {
    rootElement = root;
    layout = createLayout(root, {
      children: '[data-pane-id]',
      duration: 300,
      ease: 'out(3)',
    });
  };

  receive((event) => {
    switch (event.type) {
      case 'INIT':
        init(event.root);
        break;

      case 'ANIMATE_LAYOUT':
        if (layout) {
          layout.record();
          requestAnimationFrame(() => layout?.animate());
        }
        break;

      case 'SET_PANE_TRANSFORM':
        const el = document.querySelector(`[data-pane-id="${event.paneId}"]`) as HTMLElement;
        if (el) {
          el.style.transform = `translate(${event.x}px, ${event.y}px)`;
          el.style.zIndex = event.elevated ? '100' : '1';
        }
        break;

      case 'CLEAR_PANE_TRANSFORM':
        const paneEl = document.querySelector(`[data-pane-id="${event.paneId}"]`) as HTMLElement;
        if (paneEl) {
          // Animate back to original position
          animate(paneEl, {
            transform: 'translate(0, 0)',
            duration: 300,
            ease: 'out(3)',
            onComplete: () => {
              paneEl.style.transform = '';
              paneEl.style.zIndex = '';
            },
          });
        }
        break;
    }
  });

  return () => {
    layout?.revert();
  };
});
```

---

### Phase 4: Placeholder/Shadow Animation

#### 4.1 CSS for Placeholder

Add to `styles.css`:

```css
/* Drag placeholder - shows original position during drag */
.pane-drag-placeholder {
  background: linear-gradient(
    135deg,
    rgba(100, 150, 255, 0.1) 0%,
    rgba(100, 150, 255, 0.2) 100%
  );
  border: 2px dashed var(--accent-blue-light);
  border-radius: 4px;
  opacity: 0.8;
  transition: left 300ms ease-out, top 300ms ease-out,
              width 300ms ease-out, height 300ms ease-out;
}

/* Animate placeholder to new position when target changes */
.pane-drag-placeholder.animating {
  transition: all 300ms ease-out;
}
```

#### 4.2 Enhanced Placeholder Logic

The placeholder should:
1. Appear at the dragged pane's **original** position when drag starts
2. Animate to the **target pane's position** when hovering over a swap target
3. Animate back to original if target changes to null
4. Disappear with fade when drag ends

Update `useLayoutAnimation.ts`:

```tsx
// Add to useLayoutAnimation hook
const animatePlaceholderTo = useCallback((targetPosition: {
  left: number;
  top: number;
  width: number;
  height: number;
} | null) => {
  if (!placeholderRef.current) return;

  if (targetPosition) {
    animate(placeholderRef.current, {
      left: targetPosition.left,
      top: targetPosition.top,
      width: targetPosition.width,
      height: targetPosition.height,
      duration: 250,
      ease: 'out(2)',
    });
  }
}, []);
```

---

### Phase 5: Performance Optimizations

#### 5.1 Prevent React Re-renders During Drag

**Key Strategy:** During drag, update DOM directly via Anime.js, not through React state.

```tsx
// In dragMachine.ts - don't trigger React re-renders for position updates
DRAG_MOVE: {
  actions: enqueueActions(({ context, event, enqueue }) => {
    // ... existing logic ...

    // Instead of updating context.drag.currentX/Y on every move,
    // send directly to animation actor
    enqueue(
      sendTo('animationActor', {
        type: 'SET_PANE_TRANSFORM',
        paneId: context.drag.draggedPaneId,
        x: event.clientX - context.drag.startX,
        y: event.clientY - context.drag.startY,
        elevated: true,
      })
    );

    // Only update context when target changes (triggers React update)
    if (targetChanged) {
      enqueue(assign({ /* ... */ }));
      enqueue('notifyStateUpdate');
    }
  }),
},
```

#### 5.2 Throttle Layout Animations

```tsx
// Debounce layout animations to prevent rapid recalculations
const animateToNewPositions = useMemo(() => {
  let timeoutId: number | null = null;

  return () => {
    if (timeoutId) cancelAnimationFrame(timeoutId);

    timeoutId = requestAnimationFrame(() => {
      if (!layoutRef.current || isDragging || isResizing) return;
      layoutRef.current.record();
      requestAnimationFrame(() => layoutRef.current?.animate());
    });
  };
}, [isDragging, isResizing]);
```

#### 5.3 Use `will-change` Hint

```css
.pane-layout-item {
  will-change: transform;
}

.pane-layout-dragging .pane-layout-item {
  will-change: transform, left, top;
}
```

---

## Migration Checklist

### Files to Create
- [ ] `src/hooks/useAnimeScope.ts` - Base Anime.js scope management
- [ ] `src/hooks/useLayoutAnimation.ts` - Layout animation logic
- [ ] `src/machines/animation/animationActor.ts` - (Optional) XState actor for animations

### Files to Modify
- [ ] `src/components/PaneLayout.tsx` - Remove framer-motion, use plain divs
- [ ] `src/machines/drag/dragMachine.ts` - Optimize to avoid React re-renders
- [ ] `src/machines/app/appMachine.ts` - Add animation actor (optional)
- [ ] `src/styles.css` - Add placeholder styles, will-change hints
- [ ] `package.json` - Replace framer-motion with animejs

### Files to Delete
- [ ] None (framer-motion will be uninstalled via npm)

---

## Testing Strategy

### Unit Tests
1. `useLayoutAnimation` hook - mock Anime.js, verify correct API calls
2. Placeholder positioning logic
3. Transform calculations

### E2E Tests (existing tests should pass)
1. `pane-split.test.js` - Verify panes animate to new positions
2. `pane-swap.test.js` - Verify drag-to-swap still works
3. `pane-resize.test.js` - Verify resize preview and animation
4. `pane-close.test.js` - Verify exit animation

### Manual Testing
1. Drag pane header - should follow cursor smoothly
2. Hover over another pane - placeholder should animate to target position
3. Release - panes should animate to final positions
4. Cancel (Escape) - pane should animate back to original position
5. Resize divider - panes should resize with instant preview

---

## Rollback Plan

If issues arise:
1. Keep framer-motion in dependencies during testing
2. Feature flag: `USE_ANIME_ANIMATIONS=true/false`
3. Dual implementation with conditional import

```tsx
const AnimatedPaneLayout = process.env.USE_ANIME_ANIMATIONS
  ? React.lazy(() => import('./PaneLayout.anime'))
  : React.lazy(() => import('./PaneLayout.framer'));
```

---

## Summary of Key Decisions

| Decision | Rationale |
|----------|-----------|
| **No Draggable API** | Custom drag logic in state machine is superior for our use case |
| **Layout API for position animation** | Handles DOM reordering animation cleanly |
| **Direct DOM manipulation during drag** | Prevents React re-renders, better performance |
| **Placeholder at original position** | Visual feedback showing where pane came from |
| **Animation actor (optional)** | Clean separation of animation concerns from state machine |
| **data-pane-id for DOM access** | Stable identifiers across React re-renders |

---

## Anime.js API Reference (Quick Reference)

```typescript
// Layout API
import { createLayout } from 'animejs';

const layout = createLayout(rootElement, {
  children: '[data-pane-id]',  // CSS selector for animated children
  duration: 300,               // Animation duration in ms
  ease: 'out(3)',              // Easing function
  delay: 0,                    // Delay before animation
  properties: ['left', 'top', 'width', 'height'],  // CSS properties to animate

  // State parameters
  enterFrom: { opacity: 0 },   // New elements enter from
  leaveTo: { opacity: 0 },     // Removed elements exit to
  swapAt: { opacity: 0.5 },    // During swap

  // Callbacks
  onBegin: () => {},
  onUpdate: () => {},
  onComplete: () => {},
});

// Methods
layout.record();   // Capture current state
layout.animate();  // Animate to new state
layout.update(callback);  // Record, execute callback, animate
layout.revert();   // Cleanup

// React Integration
import { createScope, Scope } from 'animejs';

const scope = createScope({ root: element });
scope.add('methodName', () => { /* ... */ });
scope.revert();  // Cleanup
```
