/**
 * ResizeDividers - Renders resize handles between panes
 *
 * Positions invisible clickable dividers at tmux divider columns/rows.
 * Each divider is exactly 1 character cell wide/tall, matching the tmux
 * grid position of the │ or ─ divider characters.
 */

import React from 'react';
import {
  useAppSend,
  useAppSelector,
  selectVisiblePanes,
  selectGridDimensions,
} from '../machines/AppContext';
import { PANE_HEADER_HEIGHT } from '../constants';
import { mergeSegments, collectDividerSegments } from '../utils/layout';

interface ResizeDividersProps {
  centerOffsetX: number;
  centerOffsetY: number;
}

export function ResizeDividers({ centerOffsetX, centerOffsetY }: ResizeDividersProps) {
  const send = useAppSend();
  const panes = useAppSelector(selectVisiblePanes);
  const { charWidth, charHeight } = useAppSelector(selectGridDimensions);

  const { horizontal: horizontalDividers, vertical: verticalDividers } = collectDividerSegments(panes);
  const dividerElements: React.ReactElement[] = [];

  // Render horizontal dividers (between vertically stacked panes)
  // Each divider occupies 1 character row at the divider position
  horizontalDividers.forEach((segments, yPos) => {
    const merged = mergeSegments(segments);

    merged.forEach((seg, idx) => {
      dividerElements.push(
        <div
          key={`h-${yPos}-${idx}`}
          className="resize-divider resize-divider-h"
          style={{
            left: centerOffsetX + seg.start * charWidth,
            top: centerOffsetY + yPos * charHeight,
            width: (seg.end - seg.start) * charWidth,
            height: charHeight,
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
  // Each divider occupies 1 character column at the divider position
  verticalDividers.forEach((segments, xPos) => {
    const merged = mergeSegments(segments);

    merged.forEach((seg, idx) => {
      dividerElements.push(
        <div
          key={`v-${xPos}-${idx}`}
          className="resize-divider resize-divider-v"
          style={{
            left: centerOffsetX + xPos * charWidth,
            top: centerOffsetY + seg.start * charHeight,
            width: charWidth,
            height: (seg.end - seg.start) * charHeight + PANE_HEADER_HEIGHT,
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
