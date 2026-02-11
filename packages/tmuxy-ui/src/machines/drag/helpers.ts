/**
 * Helper functions for drag operations
 */

import type { TmuxPane } from '../types';
import { PANE_HEADER_HEIGHT, PANE_INSET_Y, paneInsetX } from '../../constants';

/**
 * Find swap target pane using mouse position (in pixels relative to container)
 * Accounts for PANE_HEADER_HEIGHT, insets added to each pane's rendered bounds
 * and centerOffset used to center content in the container
 */
export function findSwapTarget(
  panes: TmuxPane[],
  draggedId: string,
  mouseX: number,
  mouseY: number,
  charWidth: number,
  charHeight: number,
  centerOffsetX: number = 0,
  centerOffsetY: number = 0
): string | null {
  const insetX = paneInsetX(charWidth);

  for (const pane of panes) {
    if (pane.tmuxId === draggedId) continue;

    // Calculate pixel bounds for this pane (matching PaneLayout.tsx getPaneStyle)
    const left = centerOffsetX + pane.x * charWidth - insetX;
    const top = centerOffsetY + pane.y * charHeight - PANE_INSET_Y;
    const right = left + pane.width * charWidth + 2 * insetX;
    const bottom = top + pane.height * charHeight + PANE_HEADER_HEIGHT + 2 * PANE_INSET_Y;

    if (mouseX >= left && mouseX < right && mouseY >= top && mouseY < bottom) {
      return pane.tmuxId;
    }
  }

  return null;
}
