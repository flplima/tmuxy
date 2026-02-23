/**
 * Helper functions for drag operations
 */

import type { TmuxPane } from '../types';
import { PANE_INSET_Y, paneInsetX } from '../../constants';

/**
 * Find swap target pane using mouse position (in pixels relative to pane container)
 * Bounds match PaneLayout.tsx getPaneStyle: top includes header row (y-1),
 * height is (height+1) charHeights (content + header).
 */
export function findSwapTarget(
  panes: TmuxPane[],
  draggedId: string,
  mouseX: number,
  mouseY: number,
  charWidth: number,
  charHeight: number,
  centerOffsetX: number = 0,
  centerOffsetY: number = 0,
): string | null {
  const insetX = paneInsetX(charWidth);

  for (const pane of panes) {
    if (pane.tmuxId === draggedId) continue;

    // Calculate pixel bounds matching PaneLayout.tsx getPaneStyle
    const headerY = Math.max(0, pane.y - 1);
    const left = centerOffsetX + pane.x * charWidth - insetX;
    const top = centerOffsetY + headerY * charHeight - PANE_INSET_Y;
    const right = left + pane.width * charWidth + 2 * insetX;
    const bottom = top + (pane.height + 1) * charHeight + 2 * PANE_INSET_Y;

    if (mouseX >= left && mouseX < right && mouseY >= top && mouseY < bottom) {
      return pane.tmuxId;
    }
  }

  return null;
}
