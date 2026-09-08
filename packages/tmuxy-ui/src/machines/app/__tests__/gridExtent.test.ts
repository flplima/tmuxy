import { describe, it, expect } from 'vitest';
import { gridExtent } from '../helpers';

const pane = (windowId: string, x: number, y: number, width: number, height: number) => ({
  windowId,
  x,
  y,
  width,
  height,
});

describe('gridExtent', () => {
  it('is the far edge of the active window’s panes', () => {
    const panes = [pane('@0', 0, 0, 63, 36), pane('@0', 64, 0, 62, 36)];
    expect(gridExtent(panes, '@0', { cols: 0, rows: 0 })).toEqual({ cols: 126, rows: 36 });
  });

  it('ignores panes of other windows, however large', () => {
    // The bug: a hidden window taller than the viewport made the client ask
    // tmux for a size it could never get, on every update, and keep its
    // animations off while waiting.
    const panes = [pane('@0', 0, 0, 126, 36), pane('@3', 0, 0, 35, 43)];
    expect(gridExtent(panes, '@0', { cols: 0, rows: 0 })).toEqual({ cols: 126, rows: 36 });
  });

  it('falls back to every pane when the active window has none, and to the server size with no panes', () => {
    const panes = [pane('@3', 0, 0, 35, 43)];
    expect(gridExtent(panes, '@0', { cols: 0, rows: 0 })).toEqual({ cols: 35, rows: 43 });
    expect(gridExtent(panes, null, { cols: 0, rows: 0 })).toEqual({ cols: 35, rows: 43 });
    expect(gridExtent([], '@0', { cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
  });
});
