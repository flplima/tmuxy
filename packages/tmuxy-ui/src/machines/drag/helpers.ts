import type { TmuxPane } from '../../domain/client';
import type { PaneId } from '../../domain/ids';
import { paneBox, type GridOffset } from '../../domain/paneGeometry';

function inBox(
  box: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): boolean {
  return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
}

/** The pane under the pointer (px, container-relative), in the box PaneLayout draws it in. */
export function findSwapTarget(
  panes: TmuxPane[],
  draggedId: PaneId,
  mouseX: number,
  mouseY: number,
  charWidth: number,
  charHeight: number,
  origin: GridOffset,
): PaneId | null {
  const pane = panes.find(
    (p) =>
      p.tmuxId !== draggedId &&
      inBox(paneBox(p, charWidth, charHeight, origin.x, origin.y), mouseX, mouseY),
  );
  return pane?.tmuxId ?? null;
}
