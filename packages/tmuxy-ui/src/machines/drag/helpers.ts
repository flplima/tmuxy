/**
 * Helper functions for drag operations
 */

import type { TmuxPane } from '../types';
import type { PaneId } from '../../domain/ids';
import { paneInsetX } from '../../constants';

/**
 * Find swap target pane using mouse position (in pixels relative to pane container)
 * Bounds match PaneLayout.tsx getPaneStyle: top includes header row (y-1),
 * height is (height+1) charHeights (content + header).
 */
export function findSwapTarget(
  panes: TmuxPane[],
  draggedId: PaneId,
  mouseX: number,
  mouseY: number,
  charWidth: number,
  charHeight: number,
  centerOffsetX: number = 0,
  centerOffsetY: number = 0,
): PaneId | null {
  const insetX = paneInsetX(charWidth);

  for (const pane of panes) {
    if (pane.tmuxId === draggedId) continue;

    // Calculate pixel bounds matching PaneLayout.tsx getPaneStyle
    const headerY = Math.max(0, pane.y - 1);
    const left = centerOffsetX + pane.x * charWidth - insetX;
    const top = centerOffsetY + headerY * charHeight;
    const right = left + pane.width * charWidth + 2 * insetX;
    const heightRows = pane.y > 0 ? pane.height + 1 : pane.height;
    const bottom = top + heightRows * charHeight;

    if (mouseX >= left && mouseX < right && mouseY >= top && mouseY < bottom) {
      return pane.tmuxId;
    }
  }

  return null;
}
