/**
 * PaneLayout renders tmux panes using CSS positioning with spring animations
 *
 * - Drag by pane header to swap panes (pane follows cursor with spring physics)
 * - Resize from dividers between panes
 * - Events sent to appMachine on mouse actions
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useMemo,
  ReactNode,
} from 'react';
import { ResizeDividers } from './ResizeDividers';
import {
  computePaneBox,
  PANE_ENTER_MS,
  PANE_LEAVE_MS,
  PANE_ENTER_FROM_OPACITY,
  type PaneBox,
} from '../constants';
import { findEnterFromBox, findLeaveToBox } from '../utils/paneTransitions';
import { LeavingPanesContext } from '../machines/LeavingPanesContext';
import {
  useAppSelector,
  useAppSend,
  useIsDragging,
  useIsResizing,
  selectVisiblePanes,
  selectHiddenWindowPanes,
  selectDraggedPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectGridDimensions,
  selectContainerSize,
  selectDropTarget,
  selectEnableAnimations,
  selectSuppressLayoutTransition,
  selectGroupSwitchPaneIds,
  selectPaneKeyOverrides,
} from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';

interface PaneLayoutProps {
  children: (pane: TmuxPane) => ReactNode;
}

// One rendered pane as seen by the enter/leave/shift lifecycle: its data,
// visibility, and pixel box (null while hidden — hidden panes have no
// geometry). Keyed by the pane's effective React key (paneKeyOverrides
// honored) so the optimistic placeholder→real-id morph reads as the SAME
// pane and never re-triggers an enter animation.
interface RenderedPaneView {
  pane: TmuxPane;
  hidden: boolean;
  box: PaneBox | null;
}

interface EnterAnim {
  fromBox: PaneBox;
  flipped: boolean;
  startedAt: number;
  timer?: number;
}

interface ShiftAnim {
  timer?: number;
}

interface LeaveAnim {
  pane: TmuxPane;
  toBox: PaneBox;
  timer?: number;
}

// How the JS timers outlive the CSS transition, so the lifecycle class is
// never removed while the transition is still running.
const ANIM_TIMER_SLACK_MS = 40;

// A pane that disappears this soon after entering is a transient (e.g. the
// intermediate split of a CLI float-create) — drop it instantly instead of
// running a leave morph for a pane the user never meant to see.
const TRANSIENT_PANE_MS = 300;

export function PaneLayout({ children }: PaneLayoutProps) {
  const send = useAppSend();

  const visiblePanes = useAppSelector(selectVisiblePanes);
  const hiddenWindowPanes = useAppSelector(selectHiddenWindowPanes);
  const draggedPaneId = useAppSelector(selectDraggedPaneId);
  const dropTarget = useAppSelector(selectDropTarget);
  const {
    charWidth,
    charHeight,
    totalWidth: serverTotalWidth,
    totalHeight: serverTotalHeight,
  } = useAppSelector(selectGridDimensions);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const suppressLayoutTransition = useAppSelector(selectSuppressLayoutTransition);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);
  const paneKeyOverrides = useAppSelector(selectPaneKeyOverrides);

  const focusedFloatPaneId = useAppSelector((ctx) => ctx.focusedFloatPaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const allPanes = useAppSelector((ctx) => ctx.panes);
  const isDragging = useIsDragging();
  const isResizing = useIsResizing();

  const dragOffset = useMemo(
    () => ({ x: dragOffsetX, y: dragOffsetY }),
    [dragOffsetX, dragOffsetY],
  );

  // Derive grid dimensions from visible panes only.
  // The server's totalWidth/totalHeight includes group/float window panes whose
  // coordinates are in independent layouts — using them for centering causes the
  // active window grid to appear off-center.
  const { totalWidth, totalHeight } = useMemo(() => {
    if (visiblePanes.length === 0) {
      return { totalWidth: serverTotalWidth, totalHeight: serverTotalHeight };
    }
    return {
      totalWidth: Math.max(...visiblePanes.map((p) => p.x + p.width)),
      totalHeight: Math.max(...visiblePanes.map((p) => p.y + p.height)),
    };
  }, [visiblePanes, serverTotalWidth, serverTotalHeight]);

  // Half a charWidth — each pane reaches this far into the tmux separator
  // column on both sides so adjacent panes' outlines coincide pixel-for-pixel
  // at the shared edge (the "mosaic" look). Also the content's horizontal
  // padding, which centers the terminal text within the +1-cell-wide box.
  const hPadding = charWidth / 2;

  // Center the pane grid in the container.
  // .pane-layout is inset by CONTAINER_PADDING (CSS), so its dimensions match
  // containerWidth/Height (content-box from ResizeObserver). No padding-box
  // arithmetic needed — pane positions are relative to the content area directly.
  const liveCenteringOffset = useMemo(() => {
    const paneContentWidth = totalWidth * charWidth;
    const paneContentHeight = totalHeight * charHeight;
    // Clamp x so content never overflows the right edge.
    // This handles transient states where tmux totalWidth > targetCols.
    const idealX = (containerWidth - paneContentWidth) / 2;
    const maxX = containerWidth - paneContentWidth;
    return {
      x: Math.max(0, Math.min(idealX, maxX)),
      // Round to integer pixels so pane tops sit on whole-pixel rows —
      // matches the Math.round applied to `left` in getPaneStyle and
      // avoids sub-pixel anti-aliasing across cell-row boundaries.
      y: Math.round(Math.max(0, (containerHeight - paneContentHeight) / 2)),
    };
  }, [totalWidth, totalHeight, charWidth, charHeight, containerWidth, containerHeight]);

  // Freeze the centering offset for the duration of a drag. Mid-drag the
  // dragged pane is pinned to its original slot while the optimistic swap
  // patch moves the hovered pane into that same slot — the derived grid
  // extent transiently shrinks and re-centering would shift EVERY pane
  // sideways under the user's cursor.
  const frozenOffsetRef = useRef(liveCenteringOffset);
  if (!isDragging) {
    frozenOffsetRef.current = liveCenteringOffset;
  }
  const centeringOffset = isDragging ? frozenOffsetRef.current : liveCenteringOffset;

  const containerRef = useRef<HTMLDivElement>(null);

  // Pane enter/leave/shift lifecycle state (split & kill morph animations).
  // See the detection block below `renderedPanes` for the mechanics.
  const [, bumpAnimTick] = useReducer((x: number) => x + 1, 0);
  const enterAnimsRef = useRef(new Map<string, EnterAnim>());
  const shiftAnimsRef = useRef(new Map<string, ShiftAnim>());
  const leavingRef = useRef(new Map<string, LeaveAnim>());
  const prevViewRef = useRef<Map<string, RenderedPaneView> | null>(null);
  const prevActiveWindowIdRef = useRef<string | null | undefined>(undefined);
  const prevAllPaneIdsRef = useRef<Set<string>>(new Set());

  // Handle global mouse/touch events during drag/resize
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        send({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
      } else if (isResizing) {
        send({ type: 'RESIZE_MOVE', clientX: e.clientX, clientY: e.clientY });
      }
    };

    const handleMouseUp = () => {
      if (isDragging) {
        send({ type: 'DRAG_END' });
      } else if (isResizing) {
        send({ type: 'RESIZE_END' });
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const t = e.touches[0];
      send({ type: 'DRAG_MOVE', clientX: t.clientX, clientY: t.clientY });
    };

    const handleTouchEnd = () => {
      if (isDragging) {
        send({ type: 'DRAG_END' });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isDragging, isResizing, send]);

  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      // Uniform mosaic box: width = charWidth*(width+1), height =
      // charHeight*(height+1). The extra cell in each axis is the border whose
      // two halves are shared with neighbours (or the grid edge). See
      // computePaneBox for the geometry. A collapsed stacked pane (height 1)
      // therefore renders as 2 rows — its header title row plus a blank content
      // row — matching tmux; TerminalPane hides the content of that row.
      const box = computePaneBox(pane, charWidth, charHeight, centeringOffset.x, centeringOffset.y);
      return {
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // Content padding: half a cell each side so the terminal text fills its
        // exact charWidth*width and aligns to the tmux column grid.
        '--pane-h-padding-left': `${hPadding}px`,
        '--pane-h-padding-right': `${hPadding}px`,
      } as React.CSSProperties;
    },
    [charWidth, charHeight, centeringOffset, hPadding],
  );

  const getPaneClassName = useCallback(
    (pane: TmuxPane, key: string): string => {
      const classes = ['pane-layout-item'];
      const isActive = pane.active && !focusedFloatPaneId;
      classes.push(isActive ? 'pane-active' : 'pane-inactive');
      if (pane.tmuxId === draggedPaneId) {
        classes.push('pane-dragging');
      } else if (enterAnimsRef.current.has(key)) {
        classes.push('pane-entering');
      } else if (shiftAnimsRef.current.has(key)) {
        classes.push('pane-shifting');
      }
      return classes.join(' ');
    },
    [draggedPaneId, focusedFloatPaneId],
  );

  // Merge visible + hidden panes into one stable-ordered list so React
  // reconciles by key across tab switches — the new window's <TerminalPane>
  // instances are already mounted (just hidden), so flipping tabs is a CSS
  // class swap, not an unmount/remount. Sort by the effective React key
  // (paneKeyOverrides honored so placeholder→real transitions stay stable).
  const renderedPanes = useMemo(() => {
    const items: { pane: TmuxPane; hidden: boolean }[] = [];
    for (const pane of visiblePanes) items.push({ pane, hidden: false });
    for (const pane of hiddenWindowPanes) items.push({ pane, hidden: true });
    items.sort((a, b) => {
      const ka = paneKeyOverrides[a.pane.tmuxId] ?? a.pane.tmuxId;
      const kb = paneKeyOverrides[b.pane.tmuxId] ?? b.pane.tmuxId;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return items;
  }, [visiblePanes, hiddenWindowPanes, paneKeyOverrides]);

  // ============================================
  // Pane enter/leave/shift lifecycle (split & kill morph animations)
  // ============================================
  //
  // Each render is diffed against a snapshot of the previous render
  // (prevViewRef, updated post-commit in a layout effect). A key that
  // appears gets a FLIP enter (mounted at final geometry, rewound to the
  // split source's pre-split box before paint, transitioned into place
  // while fading in); a key that vanishes keeps rendering for the leave
  // duration, morphing into the absorber's box while fading out; panes
  // whose box changed alongside an enter/leave get `pane-shifting` so they
  // animate on the same clock. All state is local (refs + a tick reducer)
  // — detection mutations in the render phase are add-only and keyed, so
  // StrictMode's double render is a no-op; deletions happen in effects.

  const currView = useMemo(() => {
    const view = new Map<string, RenderedPaneView>();
    for (const { pane, hidden } of renderedPanes) {
      const key = paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId;
      view.set(key, {
        pane,
        hidden,
        box: hidden
          ? null
          : computePaneBox(pane, charWidth, charHeight, centeringOffset.x, centeringOffset.y),
      });
    }
    return view;
  }, [renderedPanes, paneKeyOverrides, charWidth, charHeight, centeringOffset]);

  const prevView = prevViewRef.current;
  const lifecycleEnabled =
    prevView !== null &&
    enableAnimations &&
    !isDragging &&
    !isResizing &&
    activeWindowId === prevActiveWindowIdRef.current;

  if (!lifecycleEnabled && leavingRef.current.size > 0) {
    // Window switch / drag / animations-off: in-flight leave morphs belong
    // to a layout that no longer exists — drop them instantly.
    for (const l of leavingRef.current.values()) {
      if (l.timer !== undefined) clearTimeout(l.timer);
    }
    leavingRef.current.clear();
  }

  if (lifecycleEnabled && prevView) {
    const prevBoxes = new Map<string, PaneBox>();
    for (const [key, v] of prevView) if (!v.hidden && v.box) prevBoxes.set(key, v.box);
    const currBoxes = new Map<string, PaneBox>();
    for (const [key, v] of currView) if (!v.hidden && v.box) currBoxes.set(key, v.box);

    // A key appearing in / vanishing from the render list is NOT enough:
    // group siblings and float panes are excluded from renderedPanes while
    // still alive in the model, so a group switch or float create/close
    // moves keys in and out of the render without any pane being born or
    // dying. Only morph panes that are genuinely new to (enter) or gone
    // from (leave) the model.
    const allPaneIds = new Set<string>();
    for (const p of allPanes) allPaneIds.add(p.tmuxId);
    const prevAllPaneIds = prevAllPaneIdsRef.current;

    // Enters: new visible key → FLIP from the split source's pre-split box
    // (fallback: fade in place when nothing plausibly shrank for it).
    for (const [key, v] of currView) {
      if (v.hidden || !v.box || prevView.has(key) || enterAnimsRef.current.has(key)) continue;
      const leave = leavingRef.current.get(key);
      if (leave) {
        // Kill rollback: the pane came back mid-exit — cancel the leave.
        if (leave.timer !== undefined) clearTimeout(leave.timer);
        leavingRef.current.delete(key);
        continue;
      }
      if (prevAllPaneIds.has(v.pane.tmuxId)) continue; // moved, not born
      enterAnimsRef.current.set(key, {
        fromBox: findEnterFromBox(v.box, prevBoxes, currBoxes) ?? v.box,
        flipped: false,
        startedAt: performance.now(),
      });
    }

    // Leaves: previously-visible key gone from the render entirely. A key
    // that merely went hidden (break-pane, hidden windows) stays in
    // currView and never triggers this; a pane that moved into a group
    // slot or float is caught by the model-presence check above.
    for (const [key, v] of prevView) {
      if (currView.has(key) || v.hidden || !v.box || leavingRef.current.has(key)) continue;
      if (allPaneIds.has(v.pane.tmuxId)) continue; // moved, not dead
      const enter = enterAnimsRef.current.get(key);
      if (enter && performance.now() - enter.startedAt < TRANSIENT_PANE_MS) continue;
      leavingRef.current.set(key, {
        pane: v.pane,
        toBox: findLeaveToBox(v.box, prevBoxes, currBoxes) ?? v.box,
      });
    }

    // Shifts: while any enter/leave is in flight, pre-existing panes whose
    // box changed must animate on the enter clock (not the generic 100ms
    // layout transition) so the converging edges track.
    if (enterAnimsRef.current.size > 0 || leavingRef.current.size > 0) {
      for (const [key, v] of currView) {
        if (v.hidden || !v.box) continue;
        if (enterAnimsRef.current.has(key) || shiftAnimsRef.current.has(key)) continue;
        if (v.pane.tmuxId === draggedPaneId) continue;
        if (groupSwitchPanes?.has(v.pane.tmuxId)) continue;
        const prev = prevView.get(key);
        if (!prev || prev.hidden || !prev.box) continue;
        const b = v.box;
        const p = prev.box;
        if (p.left !== b.left || p.top !== b.top || p.width !== b.width || p.height !== b.height) {
          shiftAnimsRef.current.set(key, {});
        }
      }
    }
  }

  // Frozen pane snapshots for leave animations, exposed to usePane via
  // context. Identity is kept stable across renders (rebuilt only when the
  // leaving set actually changes) so live panes' usePane subscriptions
  // don't churn on every PaneLayout render.
  const leavingPanesMapRef = useRef<ReadonlyMap<string, TmuxPane>>(new Map());
  {
    const prevMap = leavingPanesMapRef.current;
    const leaves = [...leavingRef.current.values()];
    const changed =
      prevMap.size !== leaves.length || leaves.some((l) => prevMap.get(l.pane.tmuxId) !== l.pane);
    if (changed) {
      leavingPanesMapRef.current = new Map(leaves.map((l) => [l.pane.tmuxId, l.pane]));
    }
  }
  const leavingPanesMap = leavingPanesMapRef.current;

  // Merge leaving panes into the render list at their sorted-key position:
  // relative DOM order of kept keys must not change, or React would move
  // nodes (insertBefore) and cancel their running CSS transitions.
  const renderItems: { key: string; pane: TmuxPane; hidden: boolean; leave?: LeaveAnim }[] =
    renderedPanes.map(({ pane, hidden }) => ({
      key: paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId,
      pane,
      hidden,
    }));
  if (leavingRef.current.size > 0) {
    for (const [key, leave] of leavingRef.current) {
      renderItems.push({ key, pane: leave.pane, hidden: false, leave });
    }
    renderItems.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  // Post-commit: FLIP freshly-entered panes, arm expiry timers, clean up
  // entries whose panes vanished, and snapshot this render for the next diff.
  useLayoutEffect(() => {
    const container = containerRef.current;

    for (const [key, anim] of enterAnimsRef.current) {
      if (!currView.has(key)) {
        if (anim.timer !== undefined) clearTimeout(anim.timer);
        enterAnimsRef.current.delete(key);
      }
    }
    for (const [key, shift] of shiftAnimsRef.current) {
      if (!currView.has(key)) {
        if (shift.timer !== undefined) clearTimeout(shift.timer);
        shiftAnimsRef.current.delete(key);
      }
    }

    // FLIP: rewind the entering pane to its from-box with transitions off,
    // force a style recalc there, then restore React's own inline values —
    // the .pane-entering transition morphs it into place, and neither
    // endpoint is ever painted un-animated. Restoring React's exact values
    // means a later re-render (e.g. confirm-time geometry correction) just
    // retargets the live transition.
    for (const [key, anim] of enterAnimsRef.current) {
      if (anim.flipped) continue;
      anim.flipped = true;
      const node = container?.querySelector<HTMLElement>(`[data-pane-key="${key}"]`);
      if (node) {
        const saved = {
          left: node.style.left,
          top: node.style.top,
          width: node.style.width,
          height: node.style.height,
        };
        node.style.transition = 'none';
        node.style.left = `${anim.fromBox.left}px`;
        node.style.top = `${anim.fromBox.top}px`;
        node.style.width = `${anim.fromBox.width}px`;
        node.style.height = `${anim.fromBox.height}px`;
        node.style.opacity = `${PANE_ENTER_FROM_OPACITY}`;
        node.getBoundingClientRect();
        node.style.transition = '';
        node.style.left = saved.left;
        node.style.top = saved.top;
        node.style.width = saved.width;
        node.style.height = saved.height;
        node.style.opacity = '';
      }
      anim.timer = window.setTimeout(() => {
        enterAnimsRef.current.delete(key);
        bumpAnimTick();
      }, PANE_ENTER_MS + ANIM_TIMER_SLACK_MS);
    }

    for (const [key, shift] of shiftAnimsRef.current) {
      if (shift.timer !== undefined) continue;
      shift.timer = window.setTimeout(() => {
        shiftAnimsRef.current.delete(key);
        bumpAnimTick();
      }, PANE_ENTER_MS + ANIM_TIMER_SLACK_MS);
    }
    for (const [key, leave] of leavingRef.current) {
      if (leave.timer !== undefined) continue;
      leave.timer = window.setTimeout(() => {
        leavingRef.current.delete(key);
        bumpAnimTick();
      }, PANE_LEAVE_MS + ANIM_TIMER_SLACK_MS);
    }

    prevViewRef.current = currView;
    prevActiveWindowIdRef.current = activeWindowId;
    prevAllPaneIdsRef.current = new Set(allPanes.map((p) => p.tmuxId));
  });

  // The Maps themselves are stable instances — capture them once so the
  // unmount cleanup reads their final contents.
  useEffect(() => {
    const enters = enterAnimsRef.current;
    const shifts = shiftAnimsRef.current;
    const leaves = leavingRef.current;
    return () => {
      for (const a of enters.values()) if (a.timer !== undefined) clearTimeout(a.timer);
      for (const s of shifts.values()) if (s.timer !== undefined) clearTimeout(s.timer);
      for (const l of leaves.values()) if (l.timer !== undefined) clearTimeout(l.timer);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing || suppressLayoutTransition ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      <LeavingPanesContext.Provider value={leavingPanesMap}>
        {renderItems.map(({ key, pane, hidden, leave }) => {
          if (leave) {
            // The model already dropped this pane; keep its DOM node alive
            // (same key → no remount) and retarget it at the absorber's box
            // — .pane-leaving transitions it there while fading to 0.
            return (
              <AnimatedPaneWrapper
                key={key}
                paneKey={key}
                pane={pane}
                className="pane-layout-item pane-inactive pane-leaving"
                style={
                  {
                    position: 'absolute',
                    left: leave.toBox.left,
                    top: leave.toBox.top,
                    width: leave.toBox.width,
                    height: leave.toBox.height,
                    '--pane-h-padding-left': `${hPadding}px`,
                    '--pane-h-padding-right': `${hPadding}px`,
                  } as React.CSSProperties
                }
                targetX={0}
                targetY={0}
                elevated={false}
              >
                {children(pane)}
              </AnimatedPaneWrapper>
            );
          }

          if (hidden) {
            // Keep mounted but visually absent — no positioning math, no
            // animation, no event handlers. Preserves <TerminalPane> + content
            // so a future tab switch shows the pane instantly.
            return (
              <AnimatedPaneWrapper
                key={key}
                paneKey={key}
                pane={pane}
                className="pane-layout-item pane-window-hidden"
                style={{ display: 'none' }}
                targetX={0}
                targetY={0}
                elevated={false}
              >
                {children(pane)}
              </AnimatedPaneWrapper>
            );
          }

          const isDraggedPane = pane.tmuxId === draggedPaneId;
          const baseStyle = getPaneStyle(pane);

          const isGroupSwitchPane = groupSwitchPanes?.has(pane.tmuxId) ?? false;
          const style = isGroupSwitchPane ? { ...baseStyle, transition: 'none' } : baseStyle;

          const shouldFollowCursor = isDraggedPane && isDragging;

          return (
            <AnimatedPaneWrapper
              key={key}
              paneKey={key}
              pane={pane}
              className={getPaneClassName(pane, key)}
              style={style}
              targetX={shouldFollowCursor ? dragOffset.x : 0}
              targetY={shouldFollowCursor ? dragOffset.y : 0}
              elevated={shouldFollowCursor}
            >
              {children(pane)}
            </AnimatedPaneWrapper>
          );
        })}
      </LeavingPanesContext.Provider>

      {/* Ghost indicator showing dragged pane's current grid position.
          Mirrors getPaneStyle exactly (same computePaneBox) so the ghost
          lands precisely where the pane will. */}
      {dropTarget &&
        isDragging &&
        (() => {
          const box = computePaneBox(
            dropTarget,
            charWidth,
            charHeight,
            centeringOffset.x,
            centeringOffset.y,
          );
          return <div className="pane-drag-ghost" style={{ position: 'absolute', ...box }} />;
        })()}

      <ResizeDividers
        panes={visiblePanes}
        charWidth={charWidth}
        charHeight={charHeight}
        centeringOffset={centeringOffset}
      />
    </div>
  );
}

// ============================================
// Animated Pane Wrapper
// ============================================

interface AnimatedPaneWrapperProps {
  pane: TmuxPane;
  /** Effective React key (paneKeyOverrides honored) — exposed on the DOM
   * for the enter-animation FLIP to find the node post-commit. */
  paneKey: string;
  className: string;
  style: React.CSSProperties;
  targetX: number;
  targetY: number;
  elevated: boolean;
  children: ReactNode;
}

function AnimatedPaneWrapper({
  pane,
  paneKey,
  className,
  style,
  targetX,
  targetY,
  elevated,
  children,
}: AnimatedPaneWrapperProps) {
  const transformStyle: React.CSSProperties = {
    ...style,
    transform: `translate3d(${targetX}px, ${targetY}px, 0)`,
    zIndex: elevated ? 'var(--z-dragging)' : undefined,
  };

  return (
    <div
      data-pane-id={pane.tmuxId}
      data-pane-key={paneKey}
      className={className}
      style={transformStyle}
    >
      {children}
    </div>
  );
}

export default PaneLayout;
