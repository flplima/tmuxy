import {
  CHAR_HEIGHT,
  STATUS_BAR_HEIGHT,
  TMUX_STATUS_BAR_HEIGHT,
  CONTAINER_PADDING_X,
  CONTAINER_PADDING_BOTTOM,
} from '../../constants/layout';

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
