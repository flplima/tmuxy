import type { TmuxPane } from '../../domain/client';
import type { PaneId } from '../../domain/ids';
import { paneInsetX } from '../../domain/paneGeometry';

/**
 * The pane under the pointer (px, container-relative), in the bounds
 * PaneLayout.tsx's getPaneStyle draws: a pane below the top edge includes its
 * header row above it.
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
