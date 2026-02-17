import React, { useCallback, useEffect, useRef, useMemo, useState, ReactNode } from 'react';
import { useAnimatedPane } from '../hooks/useAnimatedPane';
import {
  useAppSelector,
  useAppSend,
  useIsDragging,
  useIsCommittingDrag,
  useIsResizing,
  useIsCommittingResize,
  selectPreviewPanes,
  selectDraggedPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectGridDimensions,
  selectContainerSize,
  selectDropTarget,
  selectPaneGroups,
  selectActiveWindowId,
  selectEnableAnimations,
  selectGroupSwitchPaneIds,
} from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';
import './PaneLayout.css';

const ANIMATION_DISABLE_DURATION = 1000; // Disable animations for 1 second after commit

interface PaneLayoutProps {
  children: (pane: TmuxPane) => ReactNode;
}

/**
 * PaneLayout renders tmux panes using CSS positioning with spring animations
 *
 * - Drag by pane header to swap panes (pane follows cursor with spring physics)
 * - Resize from dividers between panes
 * - Events sent to appMachine on mouse actions
 */
export function PaneLayout({ children }: PaneLayoutProps) {
  const send = useAppSend();

  // Select state from machine (optimistic updates are applied directly to panes)
  const previewPanes = useAppSelector(selectPreviewPanes);
  const paneGroups = useAppSelector(selectPaneGroups);
  const activeWindowId = useAppSelector(selectActiveWindowId);
  const draggedPaneId = useAppSelector(selectDraggedPaneId);
  const dropTarget = useAppSelector(selectDropTarget);
  const { charWidth, charHeight, totalWidth, totalHeight } = useAppSelector(selectGridDimensions);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);

  // Use state hooks for machine state
  const isDragging = useIsDragging();
  const isCommittingDrag = useIsCommittingDrag();
  const isResizing = useIsResizing();
  const isCommittingResize = useIsCommittingResize();

  // Whether currently in a commit state (for logic like hiding drop targets)
  const isCommitting = isCommittingDrag || isCommittingResize;

  // Track when commit started to disable animations for 1 second
  const [animationsDisabled, setAnimationsDisabled] = useState(false);
  const commitStartTimeRef = useRef<number | null>(null);

  // When entering commit state, record the time and disable animations
  useEffect(() => {
    if (isCommitting && commitStartTimeRef.current === null) {
      // Just entered commit state
      commitStartTimeRef.current = Date.now();
      setAnimationsDisabled(true);

      // Re-enable animations after duration
      const timer = setTimeout(() => {
        setAnimationsDisabled(false);
        commitStartTimeRef.current = null;
      }, ANIMATION_DISABLE_DURATION);

      return () => clearTimeout(timer);
    }
  }, [isCommitting]);

  // Use previewPanes which have updated positions during drag and resize
  // During resize, previewPanes contains real-time dimension updates
  const basePanes = previewPanes;

  // Filter panes to only show visible ones (for groups, only show active pane)
  const visiblePanes = useMemo(() => {
    const groupsArray = Object.values(paneGroups);
    if (groupsArray.length === 0) return basePanes;

    return basePanes.filter((pane) => {
      // Find if this pane is in a group
      const group = groupsArray.find((g) => g.paneIds.includes(pane.tmuxId));
      if (!group) return true; // Not in a group, always visible

      // In a group - only show if it's in the active window
      // The active pane is whichever one is in the active window
      return pane.windowId === activeWindowId;
    });
  }, [basePanes, paneGroups, activeWindowId]);

  // Memoize drag offset object to prevent unnecessary re-renders
  const dragOffset = useMemo(() => ({ x: dragOffsetX, y: dragOffsetY }), [dragOffsetX, dragOffsetY]);

  // Calculate centering offset to center panes in the container
  // When container is larger than pane content, offset positions to center
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
  // Note: Escape key handling is done in the appMachine via KEY_PRESS event
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

  // Compute base position for each pane with centering
  // Each pane has a header (1 char height) above its content.
  // The header occupies the row above pane.y (for non-top panes, this is the tmux divider row).
  // Vertical dividers between side-by-side panes are exactly 1 char width (like tmux).
  // Horizontal padding: 30% of charWidth on each side
  // Gap between pane borders: 40% of charWidth
  // Total: 30% + 40% + 30% = 100% = 1 char (preserves tmux gap)
  const hPadding = Math.round(charWidth * 0.3);

  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      // Position pane so header is at (y-1) and content starts at y
      // For y=0, header would be at -1 which we clamp to 0
      const headerY = Math.max(0, pane.y - 1);

      return {
        position: 'absolute',
        // Round left position to avoid sub-pixel text clipping
        left: Math.round(centeringOffset.x + pane.x * charWidth),
        top: centeringOffset.y + headerY * charHeight,
        // Width = terminal columns + horizontal padding (30% charWidth each side)
        width: Math.ceil(pane.width * charWidth) + hPadding * 2,
        // +1 row for header (header is exactly 1 char height)
        height: (pane.height + 1) * charHeight,
      };
    },
    [charWidth, charHeight, centeringOffset, hPadding]
  );

  // Get CSS class for pane
  const getPaneClassName = useCallback(
    (pane: TmuxPane): string => {
      const classes = ['pane-layout-item'];
      classes.push(pane.active ? 'pane-active' : 'pane-inactive');

      if (pane.tmuxId === draggedPaneId) {
        classes.push('pane-dragging');
      }

      return classes.join(' ');
    },
    [draggedPaneId]
  );

  // Single pane - use same absolute positioning with centering as multi-pane
  if (visiblePanes.length === 1) {
    const pane = visiblePanes[0];
    const headerY = Math.max(0, pane.y - 1);
    return (
      <div className={`pane-layout${!enableAnimations ? ' pane-layout-no-animations' : ''}`} style={{ '--pane-h-padding': `${hPadding}px` } as React.CSSProperties}>
        <div
          className="pane-layout-item pane-active"
          data-pane-id={pane.tmuxId}
          style={{
            position: 'absolute',
            left: Math.round(centeringOffset.x + pane.x * charWidth),
            top: centeringOffset.y + headerY * charHeight,
            width: Math.ceil(pane.width * charWidth) + hPadding * 2,
            height: (pane.height + 1) * charHeight,
          }}
        >
          {children(pane)}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing ? 'pane-layout-resizing' : ''} ${animationsDisabled ? 'pane-layout-committing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
      style={{ '--pane-h-padding': `${hPadding}px` } as React.CSSProperties}
    >
      {visiblePanes.map((pane) => {
        const isDraggedPane = pane.tmuxId === draggedPaneId;
        const baseStyle = getPaneStyle(pane);

        // Disable CSS transitions on panes involved in a recent group switch
        // to prevent height clipping during the transition from override to server state
        const isGroupSwitchPane = groupSwitchPanes &&
          (pane.tmuxId === groupSwitchPanes.paneId || pane.tmuxId === groupSwitchPanes.fromPaneId);
        const style = isGroupSwitchPane
          ? { ...baseStyle, transition: 'none' }
          : baseStyle;

        // When committing, all panes animate via layout - no manual offset
        // When dragging, dragged pane follows cursor, others stay at origin
        const shouldFollowCursor = isDraggedPane && isDragging && !isCommitting;

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

      {/* Drop target indicator for swap - hide when committing */}
      {dropTarget && !isCommitting && (
        <div
          className="drop-target-indicator"
          style={{
            position: 'absolute',
            left: centeringOffset.x + dropTarget.x * charWidth,
            // Position so header occupies row above content
            top: centeringOffset.y + Math.max(0, dropTarget.y - 1) * charHeight,
            width: dropTarget.width * charWidth,
            // +1 row for header
            height: (dropTarget.height + 1) * charHeight,
          }}
        />
      )}

      {/* Resize dividers between adjacent panes */}
      <ResizeDividers panes={visiblePanes} charWidth={charWidth} charHeight={charHeight} centeringOffset={centeringOffset} />
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

/**
 * Wrapper component for panes with spring animation.
 * Uses useAnimatedPane hook to apply spring physics to transform.
 */
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
    <div
      ref={setRef}
      data-pane-id={pane.tmuxId}
      className={className}
      style={style}
    >
      {children}
    </div>
  );
}

// ============================================
// Resize Dividers
// ============================================

interface ResizeDividersProps {
  panes: TmuxPane[];
  charWidth: number;
  charHeight: number;
  centeringOffset: { x: number; y: number };
}

interface DividerSegment {
  start: number; // left for horizontal, top for vertical
  end: number;   // right for horizontal, bottom for vertical
  paneId: string; // pane to resize
}

function ResizeDividers({ panes, charWidth, charHeight, centeringOffset }: ResizeDividersProps) {
  const send = useAppSend();

  // Collect divider segments grouped by position
  // Key is the y-position for horizontal dividers, x-position for vertical
  const horizontalDividers = new Map<number, DividerSegment[]>();
  const verticalDividers = new Map<number, DividerSegment[]>();

  // Find adjacent pane pairs and collect divider segments
  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];

    for (let j = i + 1; j < panes.length; j++) {
      const other = panes[j];

      // Horizontal divider: panes share a horizontal edge (with 1-cell tmux divider gap)
      // Check both directions since pane order in array may not match visual position
      const horizontallyOverlap = pane.x < other.x + other.width && pane.x + pane.width > other.x;

      if (pane.y + pane.height + 1 === other.y && horizontallyOverlap) {
        // pane is above other
        const yPos = pane.y + pane.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);

        if (!horizontalDividers.has(yPos)) {
          horizontalDividers.set(yPos, []);
        }
        horizontalDividers.get(yPos)!.push({
          start: left,
          end: right,
          paneId: pane.tmuxId,
        });
      } else if (other.y + other.height + 1 === pane.y && horizontallyOverlap) {
        // other is above pane (reversed order in array)
        const yPos = other.y + other.height;
        const left = Math.max(pane.x, other.x);
        const right = Math.min(pane.x + pane.width, other.x + other.width);

        if (!horizontalDividers.has(yPos)) {
          horizontalDividers.set(yPos, []);
        }
        horizontalDividers.get(yPos)!.push({
          start: left,
          end: right,
          paneId: other.tmuxId, // Use other's ID since it's above
        });
      }

      // Vertical divider: panes share a vertical edge (with 1-cell tmux divider gap)
      // Check both directions since pane order in array may not match visual position
      const verticallyOverlap = pane.y < other.y + other.height && pane.y + pane.height > other.y;

      if (pane.x + pane.width + 1 === other.x && verticallyOverlap) {
        // pane is to the left of other
        const xPos = pane.x + pane.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);

        if (!verticalDividers.has(xPos)) {
          verticalDividers.set(xPos, []);
        }
        verticalDividers.get(xPos)!.push({
          start: top,
          end: bottom,
          paneId: pane.tmuxId,
        });
      } else if (other.x + other.width + 1 === pane.x && verticallyOverlap) {
        // other is to the left of pane (reversed order in array)
        const xPos = other.x + other.width;
        const top = Math.max(pane.y, other.y);
        const bottom = Math.min(pane.y + pane.height, other.y + other.height);

        if (!verticalDividers.has(xPos)) {
          verticalDividers.set(xPos, []);
        }
        verticalDividers.get(xPos)!.push({
          start: top,
          end: bottom,
          paneId: other.tmuxId, // Use other's ID since it's on the left
        });
      }
    }
  }

  // Merge adjacent/overlapping segments at each position
  const mergeSegments = (segments: DividerSegment[]): DividerSegment[] => {
    if (segments.length <= 1) return segments;

    // Sort by start position
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const merged: DividerSegment[] = [];
    let current = { ...sorted[0] };

    for (let i = 1; i < sorted.length; i++) {
      const next = sorted[i];
      // Check if segments are adjacent or overlapping (allow 1-cell gap for tmux divider)
      if (next.start <= current.end + 1) {
        // Merge: extend current segment
        current.end = Math.max(current.end, next.end);
      } else {
        // Gap: push current and start new
        merged.push(current);
        current = { ...next };
      }
    }
    merged.push(current);

    return merged;
  };

  const dividerElements: React.ReactElement[] = [];

  // Render horizontal dividers (between vertically stacked panes)
  // These are positioned at the header row (pane.y - 1) since headers use divider rows
  horizontalDividers.forEach((segments, yPos) => {
    const merged = mergeSegments(segments);
    merged.forEach((seg, idx) => {
      dividerElements.push(
        <div
          key={`h-${yPos}-${idx}`}
          className="resize-divider resize-divider-h"
          style={{
            left: centeringOffset.x + seg.start * charWidth,
            // Position at the divider row (which is now the header row for the pane below)
            top: centeringOffset.y + yPos * charHeight,
            width: (seg.end - seg.start) * charWidth,
            height: charHeight, // Full char height (header height)
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            send({
              type: 'RESIZE_START',
              paneId: seg.paneId,
              handle: 's',
              startX: e.clientX,
              startY: e.clientY,
            });
          }}
        />
      );
    });
  });

  // Render vertical dividers (between horizontally adjacent panes)
  verticalDividers.forEach((segments, xPos) => {
    const merged = mergeSegments(segments);
    merged.forEach((seg, idx) => {
      // Vertical divider spans from header row (y-1) to content bottom (y + height)
      const headerY = Math.max(0, seg.start - 1);
      dividerElements.push(
        <div
          key={`v-${xPos}-${idx}`}
          className="resize-divider resize-divider-v"
          style={{
            left: centeringOffset.x + xPos * charWidth,
            top: centeringOffset.y + headerY * charHeight,
            width: charWidth,
            // Height spans header + content rows
            height: (seg.end - headerY) * charHeight,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            send({
              type: 'RESIZE_START',
              paneId: seg.paneId,
              handle: 'e',
              startX: e.clientX,
              startY: e.clientY,
            });
          }}
        />
      );
    });
  });

  return <>{dividerElements}</>;
}

export default PaneLayout;
