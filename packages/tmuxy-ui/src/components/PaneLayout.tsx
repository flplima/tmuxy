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
  selectGroupSwitchPaneIds,
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
  const { charWidth, charHeight, totalWidth, totalHeight } = useAppSelector(selectGridDimensions);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);

  const isDragging = useIsDragging();
  const isResizing = useIsResizing();

  const dragOffset = useMemo(
    () => ({ x: dragOffsetX, y: dragOffsetY }),
    [dragOffsetX, dragOffsetY],
  );

  // Padding to cover the tmux separator column between horizontally-adjacent panes
  const hPadding = Math.round(charWidth / 2);

  // Center the pane grid in the container (no padding needed — edge panes don't extend outward)
  const centeringOffset = useMemo(() => {
    const paneContentWidth = totalWidth * charWidth;
    const paneContentHeight = totalHeight * charHeight;
    return {
      x: Math.max(0, (containerWidth - paneContentWidth) / 2),
      y: Math.max(0, (containerHeight - paneContentHeight) / 2),
    };
  }, [totalWidth, totalHeight, charWidth, charHeight, containerWidth, containerHeight]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Handle global mouse events during drag/resize
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

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
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
      // Extend vertically into the tmux separator row below the pane.
      // In DemoTmux panes start at y=1 (one header row above), so the separator
      // between stacked panes is not covered by either pane div — extend downward
      // by charHeight to close that gap. In real tmux panes start at y=0, where
      // the by-design charHeight overlap between adjacent panes already covers the
      // separator, so no extra extension is needed (it would double the overlap).
      const onBottom = pane.y + pane.height >= totalHeight;
      const padBottom = pane.y > 0 && !onBottom ? charHeight : 0;
      return {
        position: 'absolute',
        left: Math.round(centeringOffset.x + pane.x * charWidth) - padLeft,
        top: centeringOffset.y + headerY * charHeight,
        width: Math.ceil(pane.width * charWidth) + padLeft + padRight,
        height: (pane.height + 1) * charHeight + padBottom,
        '--pane-h-padding-left': `${padLeft}px`,
        '--pane-h-padding-right': `${padRight}px`,
      } as React.CSSProperties;
    },
    [charWidth, charHeight, centeringOffset, hPadding, totalWidth, totalHeight],
  );

  const getPaneClassName = useCallback(
    (pane: TmuxPane): string => {
      const classes = ['pane-layout-item'];
      classes.push(pane.active ? 'pane-active' : 'pane-inactive');
      if (pane.tmuxId === draggedPaneId) classes.push('pane-dragging');
      return classes.join(' ');
    },
    [draggedPaneId],
  );

  // Single pane shortcut
  if (visiblePanes.length === 1) {
    const pane = visiblePanes[0];
    return (
      <div className={`pane-layout${!enableAnimations ? ' pane-layout-no-animations' : ''}`}>
        <div
          className="pane-layout-item pane-active"
          data-pane-id={pane.tmuxId}
          style={getPaneStyle(pane)}
        >
          {children(pane)}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
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
            key={pane.tmuxId}
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
                height: (dropTarget.height + 1) * charHeight,
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
