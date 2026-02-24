/**
 * PaneLayout renders tmux panes using CSS positioning with spring animations
 *
 * - Drag by pane header to swap panes (pane follows cursor with spring physics)
 * - Resize from dividers between panes
 * - Events sent to appMachine on mouse actions
 */

import React, { useCallback, useEffect, useRef, useMemo, ReactNode } from 'react';
import { useAnimatedPane } from '../hooks/useAnimatedPane';
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
import './PaneLayout.css';

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

  // Calculate centering offset to center panes in the container
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

  // Horizontal padding: 30% of charWidth on each side
  const hPadding = Math.round(charWidth * 0.3);

  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      const headerY = Math.max(0, pane.y - 1);
      return {
        position: 'absolute',
        left: Math.round(centeringOffset.x + pane.x * charWidth),
        top: centeringOffset.y + headerY * charHeight,
        width: Math.ceil(pane.width * charWidth) + hPadding * 2,
        height: (pane.height + 1) * charHeight,
      };
    },
    [charWidth, charHeight, centeringOffset, hPadding],
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
      <div
        className={`pane-layout${!enableAnimations ? ' pane-layout-no-animations' : ''}`}
        style={{ '--pane-h-padding': `${hPadding}px` } as React.CSSProperties}
      >
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
      style={{ '--pane-h-padding': `${hPadding}px` } as React.CSSProperties}
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
            enableAnimations={enableAnimations}
          >
            {children(pane)}
          </AnimatedPaneWrapper>
        );
      })}

      {/* Ghost indicator showing dragged pane's current grid position */}
      {dropTarget && isDragging && (
        <div
          className="pane-drag-ghost"
          style={{
            position: 'absolute',
            left: centeringOffset.x + dropTarget.x * charWidth,
            top: centeringOffset.y + Math.max(0, dropTarget.y - 1) * charHeight,
            width: dropTarget.width * charWidth + hPadding * 2,
            height: (dropTarget.height + 1) * charHeight,
          }}
        />
      )}

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
  enableAnimations: boolean;
  children: ReactNode;
}

function AnimatedPaneWrapper({
  pane,
  className,
  style,
  targetX,
  targetY,
  elevated,
  enableAnimations,
  children,
}: AnimatedPaneWrapperProps) {
  const setRef = useAnimatedPane(targetX, targetY, elevated, enableAnimations);

  return (
    <div ref={setRef} data-pane-id={pane.tmuxId} className={className} style={style}>
      {children}
    </div>
  );
}

export default PaneLayout;
