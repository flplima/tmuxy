/**
 * PaneLayout renders tmux panes using absolute CSS positioning
 *
 * - Drag by pane header to swap panes (dragged pane follows the cursor)
 * - Resize from dividers between panes
 * - Enter/leave/shift lifecycle: CSS-transition FLIP morphs for pane
 *   split/kill/geometry changes, tracked component-locally via refs and a
 *   tick reducer (see STATE-MANAGEMENT.md "Pane enter/leave animations").
 *   A pane that CLOSES simply goes: what is animated is the space opening up,
 *   i.e. the survivors growing into it.
 * - Events sent to appMachine on mouse actions
 */

import React, { useCallback, useReducer, useRef, useMemo, ReactNode } from 'react';
import { ResizeDividers } from './ResizeDividers';
import { computePaneBox } from '../constants/layout';
import { gridExtent } from '../machines/app/helpers';
import { useAppSelector, useAppSend, useIsDragging, useIsResizing } from '../machines/appHooks';
import {
  selectVisiblePanes,
  selectActivePaneTree,
  selectHiddenWindowPanes,
  selectSettledPaneWidth,
  selectGroupSwitchPaneIds,
} from '../machines/selectors/panesAndSidebars';
import {
  selectDraggedPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectGridDimensions,
  selectContainerSize,
  selectDropTarget,
} from '../machines/selectors/layout';
import {
  selectEnableAnimations,
  selectSuppressLayoutTransition,
  selectKeyboardElsewhere,
  selectPaneKeyOverrides,
  selectSwipeNeighbor,
  selectSwipeStill,
  selectGesturePaneId,
} from '../machines/selectors/ui';
import type { TmuxPane } from '../domain/client';
import { findZoomedPane } from '../utils/layout';
import {
  detectPaneLifecycle,
  usePaneMorphCommit,
  useRenderedPanesAndView,
  type EnterAnim,
  type LeaveAnim,
  type RenderedPaneView,
  type RenderItem,
  type ShiftAnim,
} from './PaneLayoutMorph';
import { PaneLayoutItem } from './AnimatedPaneWrapper';
import { usePaneDragResizeListeners, usePaneZoomObserver } from './paneWrapperHooks';

interface PaneLayoutProps {
  children: (pane: TmuxPane) => ReactNode;
}

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
  // While a sidebar column slides, the container's width changes every frame
  // but the GRID does not: it was re-tiled for the settled width the moment
  // the toggle started (`beginSidebarMotion`). Centring a settled grid inside
  // a moving container is what used to walk the pane area sideways for the
  // length of the animation — opening the RIGHT column moved the panes' LEFT
  // edge, which nothing about that gesture should touch. Measuring against
  // the width the grid was sized for holds it still, and it is already the
  // width the offset would settle at.
  //
  // The GRID's width is taken from the target too, for the same reason: tmux's
  // re-tile lands somewhere in the middle of the animation, and an offset
  // computed from the old column count steps when it arrives. Both halves of
  // the sum settled means the offset is its final value from the first frame,
  // so the pane area simply does not move.
  const sidebarMotion = useAppSelector((ctx) => ctx.sidebarMotion);
  const settledPaneWidth = useAppSelector(selectSettledPaneWidth);
  const targetCols = useAppSelector((ctx) => ctx.targetCols);
  const settledMotion = sidebarMotion && settledPaneWidth !== null && settledPaneWidth > 0;
  const centeringWidth = settledMotion ? settledPaneWidth : containerWidth;
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const suppressLayoutTransition = useAppSelector(selectSuppressLayoutTransition);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);
  const paneKeyOverrides = useAppSelector(selectPaneKeyOverrides);

  // The active cue means "the keyboard is in this tiled pane".
  const keyboardElsewhere = useAppSelector(selectKeyboardElsewhere);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  // tmux shows ONLY the zoomed pane — the others are not visible at all. The
  // layout still knows their geometry, so without this they keep painting
  // underneath and show through the zoomed pane's translucent surface.
  const isZoomed = useAppSelector((ctx) =>
    Boolean(ctx.windows.find((w) => w.id === ctx.activeWindowId)?.zoomed),
  );
  const paneTree = useAppSelector(selectActivePaneTree);
  const allPanes = useAppSelector((ctx) => ctx.panes);
  // A trackpad gesture, as far as the panes are concerned. Each of these
  // changes once per gesture, never per step - GestureStage draws the steps.
  const swipeNeighbor = useAppSelector(selectSwipeNeighbor);
  const swipeStill = useAppSelector(selectSwipeStill);
  const gesturePaneId = useAppSelector(selectGesturePaneId);
  const isDragging = useIsDragging();
  const isResizing = useIsResizing();

  const dragOffset = useMemo(
    () => ({ x: dragOffsetX, y: dragOffsetY }),
    [dragOffsetX, dragOffsetY],
  );

  // The grid is the visible panes' extent (see gridExtent): panes of other
  // windows sit in independent layouts, and centering on them would put the
  // active window's grid off-center.
  const { totalWidth, totalHeight } = useMemo(() => {
    const { cols, rows } = gridExtent(visiblePanes, null, {
      cols: serverTotalWidth,
      rows: serverTotalHeight,
    });
    return { totalWidth: cols, totalHeight: rows };
  }, [visiblePanes, serverTotalWidth, serverTotalHeight]);

  // Which pane tmux has expanded to fill the window, or null when not zoomed.
  //
  // Identified by geometry rather than by `pane.active`: when a window is
  // zoomed tmux reports exactly one pane spanning the whole grid, and that is
  // true regardless of which client holds focus. Keying off `active` would drop
  // the zoom treatment (or, worse, hide every pane) whenever the active flag has
  // not propagated yet. See `findZoomedPane` for why it must be the pane that
  // covers BOTH corners of the grid.
  const zoomedPaneId = useMemo(
    () => (isZoomed ? (findZoomedPane(visiblePanes)?.tmuxId ?? null) : null),
    [isZoomed, visiblePanes],
  );

  // Half a charWidth — each pane reaches this far into the tmux separator
  // column on both sides so adjacent panes' outlines coincide pixel-for-pixel
  // at the shared edge (the "mosaic" look). Also the content's horizontal
  // padding, which centers the terminal text within the +1-cell-wide box.
  const hPadding = charWidth / 2;

  // Center the pane grid in the container.
  // .pane-layout is inset by CONTAINER_PADDING_X/BOTTOM (CSS), so its dimensions match
  // containerWidth/Height (content-box from ResizeObserver). No padding-box
  // arithmetic needed — pane positions are relative to the content area directly.
  const liveCenteringOffset = useMemo(() => {
    const paneContentWidth = (settledMotion ? targetCols : totalWidth) * charWidth;
    const paneContentHeight = totalHeight * charHeight;
    // Clamp x so content never overflows the right edge.
    // This handles transient states where tmux totalWidth > targetCols.
    const idealX = (centeringWidth - paneContentWidth) / 2;
    const maxX = centeringWidth - paneContentWidth;
    return {
      x: Math.max(0, Math.min(idealX, maxX)),
      // Round to integer pixels so pane tops sit on whole-pixel rows —
      // matches the Math.round applied to `left` in getPaneStyle and
      // avoids sub-pixel anti-aliasing across cell-row boundaries.
      y: Math.round(Math.max(0, (containerHeight - paneContentHeight) / 2)),
    };
  }, [
    totalWidth,
    totalHeight,
    charWidth,
    charHeight,
    centeringWidth,
    containerHeight,
    settledMotion,
    targetCols,
  ]);

  // Freeze the centering offset for the duration of a drag OR resize. Mid-drag
  // the dragged pane is pinned to its original slot while the optimistic swap
  // patch moves the hovered pane into that same slot; mid-resize the preview /
  // intermediate server layouts can transiently change the derived grid extent
  // (e.g. a pane clamped at its min size). In both cases re-centering would
  // shift EVERY pane by a cell under the user's cursor — the "row jumps up and
  // then back down while resizing" glitch. Freeze so uninvolved panes hold
  // still and only the resized panes move.
  const frozenOffsetRef = useRef(liveCenteringOffset);
  if (!isDragging && !isResizing) {
    frozenOffsetRef.current = liveCenteringOffset;
  }
  const centeringOffset = isDragging || isResizing ? frozenOffsetRef.current : liveCenteringOffset;

  // The point all non-zoomed panes collapse toward (and expand out of) during
  // a zoom: the centre of the pane grid, where the zoomed pane fills to.
  const zoomCenter = useMemo(
    () => ({
      x: centeringOffset.x + (totalWidth * charWidth) / 2,
      y: centeringOffset.y + (totalHeight * charHeight) / 2,
    }),
    [centeringOffset, totalWidth, totalHeight, charWidth, charHeight],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Pane enter/leave/shift lifecycle state (split & kill morph animations).
  // See the detection block below `renderedPanes` for the mechanics.
  const [, bumpAnimTick] = useReducer((x: number) => x + 1, 0);
  const enterAnimsRef = useRef(new Map<string, EnterAnim>());
  const shiftAnimsRef = useRef(new Map<string, ShiftAnim>());
  // The zoomed pane id across commits, for the zoom-out sibling expand. The
  // zooming pane's own grow/shrink is driven by the DOM instead (see the zoom
  // MutationObserver below).
  const prevZoomedRef = useRef<string | null>(null);
  // On zoom-OUT the collapsed siblings drop their `pane-zoom-collapsing` class in
  // the same commit that suppresses layout transitions, so without a carve-out
  // they snap from centre-scaled back to their slots. This holds the sibling
  // keys for the expand duration so a `pane-zoom-expanding` class (with a gated
  // transition) animates them back out of the centre.
  const zoomExpandRef = useRef<{ keys: Set<string>; timer?: number } | null>(null);
  const leavingRef = useRef(new Map<string, LeaveAnim>());
  const prevViewRef = useRef<Map<string, RenderedPaneView> | null>(null);
  const prevActiveWindowIdRef = useRef<string | null | undefined>(undefined);
  const prevAllPaneIdsRef = useRef<Set<string>>(new Set());

  usePaneDragResizeListeners(isDragging, isResizing, send);

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
      const isActive = pane.active && !keyboardElsewhere;
      classes.push(isActive ? 'pane-active' : 'pane-inactive');
      // tmux's marked pane: a distinct outline so it reads apart from the
      // active pane (the two are usually different panes — mark one, then
      // swap/join it from another).
      if (pane.marked) classes.push('pane-marked');
      if (pane.tmuxId === zoomedPaneId) {
        classes.push('pane-zoomed');
      }
      if (zoomExpandRef.current?.keys.has(key)) {
        classes.push('pane-zoom-expanding');
      }
      if (pane.tmuxId === draggedPaneId) {
        classes.push('pane-dragging');
      } else if (enterAnimsRef.current.has(key)) {
        classes.push('pane-entering');
      } else if (shiftAnimsRef.current.has(key)) {
        classes.push('pane-shifting');
      }
      if (swipeStill) classes.push('pane-swipe-still');
      return classes.join(' ');
    },
    [draggedPaneId, keyboardElsewhere, zoomedPaneId, swipeStill],
  );

  // ============================================
  // Pane enter/leave/shift lifecycle (split & kill morph animations)
  // ============================================
  //
  // Each render is diffed against a snapshot of the previous render
  // (prevViewRef, updated post-commit in a layout effect). A key that
  // appears gets a FLIP enter (mounted at final geometry, rewound to the
  // split source's pre-split box before paint, transitioned into place
  // while fading in); a key that vanishes holds the shift clock open for the
  // duration, shrinking into its own centre under the survivor while fading out; panes
  // whose box changed alongside an enter/leave get `pane-shifting` so they
  // animate on the same clock. All state is local (refs + a tick reducer)
  // — detection mutations in the render phase are add-only and keyed, so
  // StrictMode's double render is a no-op; deletions happen in effects.

  const { renderedPanes, currView } = useRenderedPanesAndView({
    visiblePanes,
    hiddenWindowPanes,
    paneKeyOverrides,
    zoomedPaneId,
    swipeNeighbor,
    charWidth,
    charHeight,
    centeringOffset,
  });

  const prevView = prevViewRef.current;
  const lifecycleEnabled =
    prevView !== null &&
    enableAnimations &&
    !isDragging &&
    !isResizing &&
    activeWindowId === prevActiveWindowIdRef.current;

  detectPaneLifecycle({
    lifecycleEnabled,
    prevView,
    currView,
    zoomedPaneId,
    prevZoomedRef,
    zoomExpandRef,
    paneKeyOverrides,
    allPanes,
    prevAllPaneIdsRef,
    enterAnimsRef,
    shiftAnimsRef,
    leavingRef,
    draggedPaneId,
    groupSwitchPanes,
  });

  // A closed pane leaves no node behind: the model dropped it, so it is gone
  // from the render on the same commit. What is still tracked is the WINDOW
  // its removal opened — `leavingRef` keeps the shift lifecycle running for
  // PANE_LEAVE_MS so the surviving panes grow into the space on that clock
  // rather than snapping to their new boxes.
  const renderItems: RenderItem[] = renderedPanes.map(
    ({ pane, hidden, zoomCollapsed, swipeSide }) => ({
      key: paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId,
      pane,
      hidden,
      zoomCollapsed,
      swipeSide,
    }),
  );

  usePaneMorphCommit({
    containerRef,
    currView,
    zoomedPaneId,
    activeWindowId,
    allPanes,
    enterAnimsRef,
    shiftAnimsRef,
    leavingRef,
    zoomExpandRef,
    prevZoomedRef,
    prevViewRef,
    prevActiveWindowIdRef,
    prevAllPaneIdsRef,
    bumpAnimTick,
  });

  usePaneZoomObserver({
    containerRef,
    totalWidth,
    totalHeight,
    charWidth,
    charHeight,
    zoomedPaneId,
    send,
  });

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing || suppressLayoutTransition ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      {renderItems.map((item) => (
        <PaneLayoutItem
          key={item.key}
          item={item}
          zoomCenter={zoomCenter}
          totalWidth={totalWidth}
          charWidth={charWidth}
          draggedPaneId={draggedPaneId}
          isDragging={isDragging}
          dragOffset={dragOffset}
          groupSwitchPanes={groupSwitchPanes}
          gesturePaneId={gesturePaneId}
          getPaneStyle={getPaneStyle}
          getPaneClassName={getPaneClassName}
          renderChild={children}
        />
      ))}

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
        paneTree={paneTree}
        charWidth={charWidth}
        charHeight={charHeight}
        centeringOffset={centeringOffset}
      />
    </div>
  );
}
