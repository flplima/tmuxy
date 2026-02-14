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
} from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';
import './PaneLayout.css';

const PANE_GAP = 2; // Minimal gap between panes
const HALF_GAP = PANE_GAP / 2; // 1px offset for each pane
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

  // Select state from machine
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

  // Count horizontal divider rows above a given y position
  // Horizontal dividers are rows where no pane occupies that y position
  const countDividersAbove = useCallback(
    (y: number, panes: TmuxPane[]): number => {
      if (y === 0) return 0;
      // Find all y positions where horizontal dividers exist
      // A divider row is at position (pane.y + pane.height) for panes in the top section
      const dividerRows = new Set<number>();
      panes.forEach((p) => {
        // Check if there's a pane below this one (indicating a horizontal divider between them)
        const bottomEdge = p.y + p.height;
        if (panes.some((other) => other.y === bottomEdge + 1)) {
          dividerRows.add(bottomEdge);
        }
      });
      // Count how many divider rows are above y
      return Array.from(dividerRows).filter((row) => row < y).length;
    },
    []
  );

  // Compute base position for each pane with gap adjustments and centering
  // Horizontal gaps are compressed from charHeight to charWidth for visual consistency
  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      const dividersAbove = countDividersAbove(pane.y, visiblePanes);
      // Compress vertical gap: subtract (charHeight - charWidth) per divider
      const verticalCompression = dividersAbove * (charHeight - charWidth);
      return {
        position: 'absolute',
        left: centeringOffset.x + pane.x * charWidth + HALF_GAP,
        top: centeringOffset.y + pane.y * charHeight - verticalCompression + HALF_GAP,
        width: pane.width * charWidth - PANE_GAP,
        height: pane.height * charHeight - PANE_GAP,
      };
    },
    [charWidth, charHeight, visiblePanes, countDividersAbove, centeringOffset]
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

  // Single pane - no grid needed, but still apply HALF_GAP margin for consistent 8px spacing
  if (visiblePanes.length === 1) {
    return (
      <div
        className="pane-layout-single"
        data-pane-id={visiblePanes[0].tmuxId}
        style={{ margin: HALF_GAP }}
      >
        {children(visiblePanes[0])}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing ? 'pane-layout-resizing' : ''} ${animationsDisabled ? 'pane-layout-committing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      {visiblePanes.map((pane) => {
        const isDraggedPane = pane.tmuxId === draggedPaneId;
        const baseStyle = getPaneStyle(pane);

        // When committing, all panes animate via layout - no manual offset
        // When dragging, dragged pane follows cursor, others stay at origin
        const shouldFollowCursor = isDraggedPane && isDragging && !isCommitting;

        return (
          <AnimatedPaneWrapper
            key={pane.tmuxId}
            pane={pane}
            className={getPaneClassName(pane)}
            style={baseStyle}
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
            left: centeringOffset.x + dropTarget.x * charWidth + HALF_GAP,
            top: centeringOffset.y + dropTarget.y * charHeight + HALF_GAP,
            width: dropTarget.width * charWidth - PANE_GAP,
            height: dropTarget.height * charHeight - PANE_GAP,
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

  // Helper to count horizontal dividers above a given y position
  const countDividersAbove = (y: number): number => {
    if (y === 0) return 0;
    const dividerRows = new Set<number>();
    panes.forEach((p) => {
      const bottomEdge = p.y + p.height;
      if (panes.some((other) => other.y === bottomEdge + 1)) {
        dividerRows.add(bottomEdge);
      }
    });
    return Array.from(dividerRows).filter((row) => row < y).length;
  };

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

  // Render horizontal dividers
  horizontalDividers.forEach((segments, yPos) => {
    const merged = mergeSegments(segments);
    // Calculate vertical compression for this divider position
    const dividersAbove = countDividersAbove(yPos);
    const verticalCompression = dividersAbove * (charHeight - charWidth);
    merged.forEach((seg, idx) => {
      dividerElements.push(
        <div
          key={`h-${yPos}-${idx}`}
          className="resize-divider resize-divider-h"
          style={{
            left: centeringOffset.x + seg.start * charWidth + HALF_GAP,
            // Position with vertical compression, gap is now charWidth
            top: centeringOffset.y + yPos * charHeight - verticalCompression,
            width: (seg.end - seg.start) * charWidth - PANE_GAP,
            height: charWidth, // Use charWidth for consistent divider thickness
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

  // Render vertical dividers
  verticalDividers.forEach((segments, xPos) => {
    const merged = mergeSegments(segments);
    merged.forEach((seg, idx) => {
      // Calculate vertical compression for start and end positions
      const dividersAboveStart = countDividersAbove(seg.start);
      const dividersAboveEnd = countDividersAbove(seg.end);
      const startCompression = dividersAboveStart * (charHeight - charWidth);
      const endCompression = dividersAboveEnd * (charHeight - charWidth);
      // Height is reduced by the difference in compression
      const heightReduction = endCompression - startCompression;
      dividerElements.push(
        <div
          key={`v-${xPos}-${idx}`}
          className="resize-divider resize-divider-v"
          style={{
            left: centeringOffset.x + xPos * charWidth + HALF_GAP,
            top: centeringOffset.y + seg.start * charHeight - startCompression + HALF_GAP,
            width: charWidth,
            height: (seg.end - seg.start) * charHeight - PANE_GAP - heightReduction,
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
