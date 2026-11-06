import type { TmuxPane } from '../domain/client';
import {
  CHAR_HEIGHT,
  STATUS_BAR_HEIGHT,
  TMUX_STATUS_BAR_HEIGHT,
  CONTAINER_PADDING_X,
  CONTAINER_PADDING_BOTTOM,
} from './layout';

/**
 * The cols/rows that fit the available space: the content box of
 * .pane-container when measured (its padding is the grid's margin), else the
 * window minus the bars. With several clients attached the server takes the
 * minimum across them, as tmux does.
 */
export function calculateTargetSize(
  charWidth: number,
  containerWidth?: number,
  containerHeight?: number,
): { cols: number; rows: number } {
  const availableWidth =
    containerWidth != null ? containerWidth : window.innerWidth - CONTAINER_PADDING_X * 2;
  const availableHeight =
    containerHeight != null
      ? containerHeight
      : window.innerHeight - STATUS_BAR_HEIGHT - TMUX_STATUS_BAR_HEIGHT - CONTAINER_PADDING_BOTTOM;

  const cols = Math.floor(availableWidth / charWidth);
  const rows = Math.floor(availableHeight / CHAR_HEIGHT);

  return { cols: Math.max(10, cols), rows: Math.max(5, rows) };
}

/**
 * The pane tmux has zoomed, identified by geometry: while a window is zoomed
 * tmux reports the zoomed pane spanning the whole grid while every other pane
 * keeps its pre-zoom box. Only the zoomed pane covers both corners (the
 * bottom-right pane of any layout touches the far one too). Null when no pane
 * spans the grid.
 */
export function findZoomedPane<P extends Pick<TmuxPane, 'x' | 'y' | 'width' | 'height'>>(
  panes: readonly P[],
): P | null {
  if (panes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxRight = 0;
  let maxBottom = 0;
  for (const p of panes) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxRight = Math.max(maxRight, p.x + p.width);
    maxBottom = Math.max(maxBottom, p.y + p.height);
  }
  return (
    panes.find(
      (p) => p.x <= minX && p.y <= minY && p.x + p.width >= maxRight && p.y + p.height >= maxBottom,
    ) ?? null
  );
}
