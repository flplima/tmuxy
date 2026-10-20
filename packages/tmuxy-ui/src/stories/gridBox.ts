/**
 * Pixel box that makes the app settle on exactly `cols` x `rows`.
 *
 * The app does not take a terminal size — it MEASURES one, from the pane
 * container's content box (`calculateTargetSize`). So a story asks for a grid
 * by handing the harness a box that measures back to it:
 *
 *   cols = floor(containerContentWidth  / cellWidth)
 *   rows = floor(containerContentHeight / CHAR_HEIGHT)
 *
 * The width has to come from the MEASURED cell, not a constant: the terminal
 * font's advance is ~9px at one font size and ~9.6px at another, so a fixed
 * pixel width is 80 columns on one machine and 79 or 81 on the next. The
 * height is safe in constants — rows are always CHAR_HEIGHT tall.
 */

import {
  CHAR_HEIGHT,
  CONTAINER_PADDING_BOTTOM,
  CONTAINER_PADDING_X,
  STATUS_BAR_HEIGHT,
  TMUX_STATUS_BAR_HEIGHT,
} from '../constants/layout';
import { measureCellMetrics } from '../utils/cellMetrics';

export function gridBox(cols: number, rows: number): { width: number; height: number } {
  const { cellWidth } = measureCellMetrics();
  return {
    width: cols * cellWidth + CONTAINER_PADDING_X * 2,
    height:
      rows * CHAR_HEIGHT + CONTAINER_PADDING_BOTTOM + STATUS_BAR_HEIGHT + TMUX_STATUS_BAR_HEIGHT,
  };
}
