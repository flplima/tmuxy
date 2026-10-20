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
import { useEffect, useState } from 'react';
import { measureCellMetrics } from '../utils/cellMetrics';

export function gridBox(cols: number, rows: number): { width: number; height: number } {
  const { cellWidth } = measureCellMetrics();
  return {
    width: cols * cellWidth + CONTAINER_PADDING_X * 2,
    height:
      rows * CHAR_HEIGHT + CONTAINER_PADDING_BOTTOM + STATUS_BAR_HEIGHT + TMUX_STATUS_BAR_HEIGHT,
  };
}

/**
 * `gridBox`, measured once the terminal font has loaded. Measured before, the
 * cell is the fallback font's and the box comes out a different number of
 * columns than the story asked for. Null until then.
 */
export function useGridBox(cols: number, rows: number): { width: number; height: number } | null {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    let live = true;
    const probe = document.createElement('pre');
    probe.className = 'terminal-content';
    document.body.appendChild(probe);
    const font = getComputedStyle(probe).font;
    probe.remove();
    document.fonts
      .load(font, 'M')
      .catch(() => [])
      .then(() => {
        if (live) setBox(gridBox(cols, rows));
      });
    return () => {
      live = false;
    };
  }, [cols, rows]);
  return box;
}
