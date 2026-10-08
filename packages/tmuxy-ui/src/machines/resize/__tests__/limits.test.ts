/**
 * How far a divider may be dragged before tmux would refuse the resize.
 *
 * The geometry here is in cells, the way tmux reports it: a pane's box
 * excludes the one-cell separator between it and the next pane, so two panes
 * side by side at x=0 w=40 and x=41 w=39 share the divider at column 40.
 */

import { describe, it, expect } from 'vitest';
import { pid } from '../../../test/wire';
import {
  resizeLimits,
  resizedBand,
  dragCells,
  clampDelta,
  isLocked,
  PANE_MIN_CELLS,
} from '../limits';
import type { PaneCellBox } from '../../types';

const boxes = (entries: Record<string, PaneCellBox>) => entries;

describe('resizedBand', () => {
  it('grows the pane on the near side and pushes the one across the line', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    expect(resizedBand(geometry, pid('%0'), 'e', 5)).toEqual({
      [pid('%0')]: { x: 0, y: 0, width: 45, height: 20 },
      [pid('%1')]: { x: 46, y: 0, width: 34, height: 20 },
    });
  });

  it('moves every pane sharing the edge, and lists nothing else', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 9 },
      [pid('%1')]: { x: 0, y: 10, width: 40, height: 10 },
      [pid('%2')]: { x: 41, y: 0, width: 39, height: 20 },
      [pid('%3')]: { x: 81, y: 0, width: 10, height: 20 },
    });
    const band = resizedBand(geometry, pid('%0'), 'e', -3);
    expect(Object.keys(band).sort()).toEqual([pid('%0'), pid('%1'), pid('%2')]);
    expect(band[pid('%1')]).toEqual({ x: 0, y: 10, width: 37, height: 10 });
    expect(band[pid('%2')]).toEqual({ x: 38, y: 0, width: 42, height: 20 });
  });

  it('a w or n handle moves the pane itself, which shrinks as its edge comes in', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    expect(resizedBand(geometry, pid('%1'), 'w', 4)).toEqual({
      [pid('%0')]: { x: 0, y: 0, width: 44, height: 20 },
      [pid('%1')]: { x: 45, y: 0, width: 35, height: 20 },
    });
  });

  it('reads the demo engine two-row gap as the same divider', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 10 },
      [pid('%1')]: { x: 0, y: 12, width: 80, height: 8 },
    });
    expect(resizedBand(geometry, pid('%0'), 's', 2)).toEqual({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 12 },
      [pid('%1')]: { x: 0, y: 14, width: 80, height: 6 },
    });
    expect(resizedBand(geometry, pid('%1'), 'n', -2)).toEqual({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 8 },
      [pid('%1')]: { x: 0, y: 10, width: 80, height: 10 },
    });
  });

  it('never draws a pane below one cell', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    expect(resizedBand(geometry, pid('%0'), 'e', 100)[pid('%1')].width).toBe(PANE_MIN_CELLS);
  });

  it('moves nothing for a pane that is not in the geometry', () => {
    expect(resizedBand({}, pid('%9'), 'e', 3)).toEqual({});
  });
});

describe('dragCells', () => {
  const limits = { min: -9, max: 8 };

  it('reads the pixel delta along the handle axis, in whole cells', () => {
    const pixelDelta = { x: 31, y: -47 };
    expect(dragCells({ handle: 'e', pixelDelta, limits }, 10, 20)).toBe(3);
    expect(dragCells({ handle: 's', pixelDelta, limits }, 10, 20)).toBe(-2);
  });

  it('holds the drag inside the limits', () => {
    expect(dragCells({ handle: 'e', pixelDelta: { x: 500, y: 0 }, limits }, 10, 20)).toBe(8);
    expect(dragCells({ handle: 'n', pixelDelta: { x: 0, y: -500 }, limits }, 10, 20)).toBe(-9);
  });
});

describe('resizeLimits', () => {
  it('lets a side-by-side pair move until one of them would go below a cell', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    // Right: %1 gives up 39 - 1. Left: %0 gives up 40 - 1.
    expect(resizeLimits(geometry, pid('%0'), 'e')).toEqual({ min: -39, max: 38 });
  });

  it('measures a stacked pair the same way on the vertical axis', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 10 },
      [pid('%1')]: { x: 0, y: 11, width: 80, height: 9 },
    });
    expect(resizeLimits(geometry, pid('%0'), 's')).toEqual({ min: -9, max: 8 });
  });

  it('reads the demo engine two-row gap as the same divider', () => {
    // The demo draws a header row as well as the separator, so the next pane
    // starts two rows below rather than one.
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 10 },
      [pid('%1')]: { x: 0, y: 12, width: 80, height: 8 },
    });
    expect(resizeLimits(geometry, pid('%0'), 's')).toEqual({ min: -9, max: 7 });
  });

  it('takes the tightest pane when a band has several across the line', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 9 },
      [pid('%2')]: { x: 41, y: 10, width: 12, height: 10 },
    });
    // %2 is the narrow one, so it decides how far right the divider can go.
    expect(resizeLimits(geometry, pid('%0'), 'e').max).toBe(11);
  });

  it('pins a divider whose far side is already down to one cell', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 80, height: 1 },
      [pid('%1')]: { x: 0, y: 2, width: 80, height: 1 },
    });
    const limits = resizeLimits(geometry, pid('%0'), 's');
    expect(limits).toEqual({ min: 0, max: 0 });
    expect(isLocked(limits)).toBe(true);
  });

  it('pins an edge with nothing across it — a lone pane has no divider to drag', () => {
    const geometry = boxes({ [pid('%0')]: { x: 0, y: 0, width: 80, height: 20 } });
    expect(isLocked(resizeLimits(geometry, pid('%0'), 'e'))).toBe(true);
    expect(isLocked(resizeLimits(geometry, pid('%0'), 's'))).toBe(true);
  });

  it('is locked for a pane that is not in the geometry at all', () => {
    expect(isLocked(resizeLimits({}, pid('%9'), 'e'))).toBe(true);
  });

  it('moves the leading edge for a w handle, so the pane itself is the one that shrinks', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    // Dragging %1's left edge right shrinks %1 (39 - 1) and grows %0; dragging
    // it left shrinks %0 (40 - 1).
    expect(resizeLimits(geometry, pid('%1'), 'w')).toEqual({ min: -39, max: 38 });
  });

  it('leaves exactly one cell behind at the far end of the range', () => {
    const geometry = boxes({
      [pid('%0')]: { x: 0, y: 0, width: 40, height: 20 },
      [pid('%1')]: { x: 41, y: 0, width: 39, height: 20 },
    });
    const { max } = resizeLimits(geometry, pid('%0'), 'e');
    expect(39 - max).toBe(PANE_MIN_CELLS);
  });
});

describe('clampDelta', () => {
  it('holds a drag inside the range', () => {
    expect(clampDelta(100, { min: -9, max: 8 })).toBe(8);
    expect(clampDelta(-100, { min: -9, max: 8 })).toBe(-9);
    expect(clampDelta(3, { min: -9, max: 8 })).toBe(3);
  });

  it('leaves the delta alone when there are no limits to apply', () => {
    expect(clampDelta(100, undefined)).toBe(100);
  });
});
