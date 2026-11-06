/** Split, kill and geometry morphs: see docs/STATE-MANAGEMENT-UPDATES.md "Pane enter/leave animations". */

import React, { useCallback, useReducer, useRef, useMemo, ReactNode } from 'react';
import { ResizeDividers } from './ResizeDividers';
import {
  centeringOffset as gridCenteringOffset,
  gridPixelSize,
  paneBox,
  paneContentPadding,
} from '../domain/paneGeometry';
import { gridExtent } from '../machines/app/helpers';
import { useAppSelector, useAppSend, useIsDragging, useIsResizing } from '../machines/appHooks';
import {
  selectVisiblePanes,
  selectActivePaneTree,
  selectHiddenWindowPanes,
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
import { findZoomedPane } from '../constants/gridSize';
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
import { useMorphContentAnchor } from './paneContentAnchor';

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
  const { width: containerWidth } = useAppSelector(selectContainerSize);
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const suppressLayoutTransition = useAppSelector(selectSuppressLayoutTransition);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);
  const paneKeyOverrides = useAppSelector(selectPaneKeyOverrides);

  // The active cue means "the keyboard is in this tiled pane".
  const keyboardElsewhere = useAppSelector(selectKeyboardElsewhere);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  // tmux shows only the zoomed pane; the others would otherwise paint under
  // it and show through its translucent surface.
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

  // Other windows' panes sit in independent layouts; centring on them would
  // put the active window's grid off-centre.
  const { totalWidth, totalHeight } = useMemo(() => {
    const { cols, rows } = gridExtent(visiblePanes, null, {
      cols: serverTotalWidth,
      rows: serverTotalHeight,
    });
    return { totalWidth: cols, totalHeight: rows };
  }, [visiblePanes, serverTotalWidth, serverTotalHeight]);

  // By geometry, not `pane.active`: a zoomed window reports exactly one pane
  // spanning the grid whichever client holds focus, while the active flag can
  // lag and would hide every pane.
  const zoomedPaneId = useMemo(
    () => (isZoomed ? (findZoomedPane(visiblePanes)?.tmuxId ?? null) : null),
    [isZoomed, visiblePanes],
  );

  const hPadding = paneContentPadding(charWidth);
  const grid = useMemo(
    () => gridPixelSize(totalWidth, totalHeight, charWidth, charHeight),
    [totalWidth, totalHeight, charWidth, charHeight],
  );

  // .pane-layout is inset by the container's padding (CSS), so pane positions
  // are relative to the content box ResizeObserver measured.
  const liveCenteringOffset = useMemo(
    () => gridCenteringOffset(containerWidth, grid.width),
    [containerWidth, grid.width],
  );

  // Frozen during a drag or resize: the optimistic swap and intermediate
  // server layouts change the grid extent for a moment, and re-centring would
  // shift every pane by a cell under the cursor.
  const frozenOffsetRef = useRef(liveCenteringOffset);
  if (!isDragging && !isResizing) {
    frozenOffsetRef.current = liveCenteringOffset;
  }
  const centeringOffset = isDragging || isResizing ? frozenOffsetRef.current : liveCenteringOffset;

  const zoomCenter = useMemo(
    () => ({ x: centeringOffset.x + grid.width / 2, y: centeringOffset.y + grid.height / 2 }),
    [centeringOffset, grid],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  const [, bumpAnimTick] = useReducer((x: number) => x + 1, 0);
  const enterAnimsRef = useRef(new Map<string, EnterAnim>());
  const shiftAnimsRef = useRef(new Map<string, ShiftAnim>());
  // For the zoom-out sibling expand; the zooming pane's own grow/shrink is
  // usePaneZoomObserver's.
  const prevZoomedRef = useRef<string | null>(null);
  // On zoom out the siblings lose `pane-zoom-collapsing` in the same commit that
  // suppresses layout transitions; `pane-zoom-expanding` carries a gated
  // transition so they do not snap back to their slots.
  const zoomExpandRef = useRef<{ keys: Set<string>; timer?: number } | null>(null);
  const leavingRef = useRef(new Map<string, LeaveAnim>());
  const prevViewRef = useRef<Map<string, RenderedPaneView> | null>(null);
  const prevActiveWindowIdRef = useRef<string | null | undefined>(undefined);
  const prevAllPaneIdsRef = useRef<Set<string>>(new Set());

  usePaneDragResizeListeners(isDragging, isResizing, send);

  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      // A collapsed stacked pane (height 1) renders as 2 rows, header plus a
      // blank content row, as tmux does; TerminalPane hides that row.
      const box = paneBox(pane, charWidth, charHeight, centeringOffset.x, centeringOffset.y);
      return {
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // Half a cell each side, so the text aligns to the tmux column grid.
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

  // Detection in the render phase only adds, keyed, so StrictMode's double
  // render is a no-op; deletions happen in effects.

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

  useMorphContentAnchor(containerRef, currView);

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

      {dropTarget &&
        isDragging &&
        (() => {
          const box = paneBox(
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
