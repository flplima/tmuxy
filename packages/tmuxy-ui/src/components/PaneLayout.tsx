/**
 * PaneLayout renders tmux panes using CSS positioning with spring animations
 *
 * - Drag by pane header to swap panes (pane follows cursor with spring physics)
 * - Resize from dividers between panes
 * - Events sent to appMachine on mouse actions
 */

import React, { useCallback, useEffect, useRef, useMemo, ReactNode } from 'react';
import { ResizeDividers } from './ResizeDividers';
import { computePaneBox } from '../constants';
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
  const centeringOffset = useMemo(() => {
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

  const containerRef = useRef<HTMLDivElement>(null);

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
    (pane: TmuxPane): string => {
      const classes = ['pane-layout-item'];
      const isActive = pane.active && !focusedFloatPaneId;
      classes.push(isActive ? 'pane-active' : 'pane-inactive');
      if (pane.tmuxId === draggedPaneId) classes.push('pane-dragging');
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

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing || suppressLayoutTransition ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      {renderedPanes.map(({ pane, hidden }) => {
        if (hidden) {
          // Keep mounted but visually absent — no positioning math, no
          // animation, no event handlers. Preserves <TerminalPane> + content
          // so a future tab switch shows the pane instantly.
          return (
            <AnimatedPaneWrapper
              key={paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId}
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
            key={paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId}
            pane={pane}
            className={getPaneClassName(pane)}
            style={style}
            targetX={shouldFollowCursor ? dragOffset.x : 0}
            targetY={shouldFollowCursor ? dragOffset.y : 0}
            elevated={shouldFollowCursor}
          >
            {children(pane)}
          </AnimatedPaneWrapper>
        );
      })}

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
  className: string;
  style: React.CSSProperties;
  targetX: number;
  targetY: number;
  elevated: boolean;
  children: ReactNode;
}

function AnimatedPaneWrapper({
  pane,
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
    <div data-pane-id={pane.tmuxId} className={className} style={transformStyle}>
      {children}
    </div>
  );
}

export default PaneLayout;
