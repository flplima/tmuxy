/**
 * PaneLayout renders tmux panes using CSS positioning with spring animations
 *
 * - Drag by pane header to swap panes (pane follows cursor with spring physics)
 * - Resize from dividers between panes
 * - Events sent to appMachine on mouse actions
 */

import React, { useCallback, useEffect, useRef, useMemo, ReactNode } from 'react';
import { ResizeDividers } from './ResizeDividers';
import {
  useAppSelector,
  useAppSend,
  useIsDragging,
  useIsResizing,
  selectVisiblePanes,
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

  // Padding to cover the tmux separator column between horizontally-adjacent panes
  const hPadding = Math.round(charWidth / 2);

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
      y: Math.max(0, (containerHeight - paneContentHeight) / 2),
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
      const headerY = Math.max(0, pane.y - 1);
      // Extend horizontally into the tmux separator column between adjacent panes.
      const onLeft = pane.x === 0;
      const onRight = pane.x + pane.width >= totalWidth;
      const padLeft = onLeft ? 0 : hPadding;
      const padRight = onRight ? 0 : hPadding;
      // With pane-border-status top, the layout height for y=0 panes already
      // includes the border-title row. For y>0 panes, the border-title sits in
      // the separator row at y-1, which is NOT included in the layout height,
      // so we add 1 extra row for the header.
      const heightRows = pane.y > 0 ? pane.height + 1 : pane.height;
      return {
        position: 'absolute',
        left: Math.round(centeringOffset.x + pane.x * charWidth) - padLeft,
        top: centeringOffset.y + headerY * charHeight,
        width: Math.round(pane.width * charWidth) + padLeft + padRight,
        height: heightRows * charHeight,
        '--pane-h-padding-left': `${padLeft}px`,
        '--pane-h-padding-right': `${padRight}px`,
      } as React.CSSProperties;
    },
    [charWidth, charHeight, centeringOffset, hPadding, totalWidth, totalHeight],
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

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing || suppressLayoutTransition ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      {visiblePanes.map((pane) => {
        const isDraggedPane = pane.tmuxId === draggedPaneId;
        const baseStyle = getPaneStyle(pane);

        const isGroupSwitchPane =
          groupSwitchPanes &&
          (pane.tmuxId === groupSwitchPanes.paneId || pane.tmuxId === groupSwitchPanes.fromPaneId);
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

      {/* Ghost indicator showing dragged pane's current grid position */}
      {dropTarget &&
        isDragging &&
        (() => {
          const gl = dropTarget.x === 0 ? 0 : hPadding;
          const gr = dropTarget.x + dropTarget.width >= totalWidth ? 0 : hPadding;
          return (
            <div
              className="pane-drag-ghost"
              style={{
                position: 'absolute',
                left: centeringOffset.x + dropTarget.x * charWidth - gl,
                top: centeringOffset.y + Math.max(0, dropTarget.y - 1) * charHeight,
                width: dropTarget.width * charWidth + gl + gr,
                height: (dropTarget.y > 0 ? dropTarget.height + 1 : dropTarget.height) * charHeight,
              }}
            />
          );
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
