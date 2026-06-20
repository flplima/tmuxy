import { describe, it, expect } from 'vitest';
import {
  computePaneBox,
  isCollapsedPane,
  CHAR_HEIGHT,
  PANE_HEADER_HEIGHT,
  type PaneBoxInput,
} from '../layout';

// Representative cell metrics (charWidth is measured at runtime; height is fixed).
const CW = 9.6;
const CH = CHAR_HEIGHT;

describe('pane header height', () => {
  it('equals exactly one character cell height', () => {
    // The header must consume exactly one terminal row so the mosaic stays on
    // the cell grid (the +1 row in every pane's height IS this header).
    expect(PANE_HEADER_HEIGHT).toBe(CH);
  });
});

describe('computePaneBox — mosaic size invariant', () => {
  const cases: PaneBoxInput[] = [
    { x: 0, y: 1, width: 80, height: 24 }, // single full pane (both edges)
    { x: 0, y: 1, width: 80, height: 12 }, // left/top pane of a split
    { x: 81, y: 1, width: 78, height: 12 }, // right pane (inner left edge)
    { x: 0, y: 14, width: 159, height: 10 }, // bottom-spanning pane
  ];

  it.each(cases)('width = charWidth * (width + 1) for %o', (pane) => {
    const box = computePaneBox(pane, CW, CH);
    expect(box.width).toBeCloseTo(CW * (pane.width + 1), 10);
  });

  it.each(cases)('height = charHeight * (height + 1) for %o', (pane) => {
    const box = computePaneBox(pane, CW, CH);
    expect(box.height).toBeCloseTo(CH * (pane.height + 1), 10);
  });

  it('holds regardless of the grid offset', () => {
    const pane: PaneBoxInput = { x: 5, y: 3, width: 40, height: 20 };
    const a = computePaneBox(pane, CW, CH, 0, 0);
    const b = computePaneBox(pane, CW, CH, 100, 50);
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(b.left - a.left).toBeCloseTo(100, 10);
    expect(b.top - a.top).toBeCloseTo(50, 10);
  });
});

describe('computePaneBox — no gaps between panes (mosaic)', () => {
  it('horizontally adjacent panes share an exact edge', () => {
    // Two side-by-side panes with tmux's 1-column separator between them:
    // left content cols 0..79, separator col 80, right content starts col 81.
    const left: PaneBoxInput = { x: 0, y: 1, width: 80, height: 24 };
    const right: PaneBoxInput = { x: 81, y: 1, width: 79, height: 24 };

    const lb = computePaneBox(left, CW, CH);
    const rb = computePaneBox(right, CW, CH);

    // The right pane's left edge meets the left pane's right edge exactly —
    // no gap, no overlap: their 1px outlines coincide.
    expect(rb.left).toBeCloseTo(lb.left + lb.width, 10);
  });

  it('vertically adjacent panes share an exact edge', () => {
    // Two stacked panes with tmux's 1-row separator: top content rows 1..24,
    // separator row 25, bottom content starts row 26 (its header sits in row 25).
    const top: PaneBoxInput = { x: 0, y: 1, width: 160, height: 24 };
    const bottom: PaneBoxInput = { x: 0, y: 26, width: 160, height: 23 };

    const tb = computePaneBox(top, CW, CH);
    const bb = computePaneBox(bottom, CW, CH);

    expect(bb.top).toBeCloseTo(tb.top + tb.height, 10);
  });

  it('the topmost pane header sits flush with the grid origin', () => {
    // Under pane-border-status top the top pane has y=1; its header occupies
    // the row at y-1 = 0, so its box starts exactly at the offset (no clipping
    // above the grid).
    const top: PaneBoxInput = { x: 0, y: 1, width: 160, height: 24 };
    const box = computePaneBox(top, CW, CH, 0, 0);
    expect(box.top).toBe(0);
  });

  it('clamps a y=0 pane so it is not hoisted a full cell above the grid', () => {
    // Some tiled layouts report the top row at y=0 (no separator row above).
    // The pane has no header to hoist: its top must not go negative and it
    // gets no extra header row in its height.
    const top: PaneBoxInput = { x: 0, y: 0, width: 160, height: 24 };
    const box = computePaneBox(top, CW, CH, 50, 30);
    expect(box.top).toBe(30); // offsetY, not offsetY - CH
    expect(box.height).toBe(24 * CH); // height rows, no +1 header
  });
});

describe('computePaneBox — collapsed stacked pane', () => {
  it('renders a collapsed (height 1) pane as 2 rows: header title + blank content', () => {
    // tmux collapses a stacked pane to height 1; the box is therefore 2 cells
    // tall (header row + one content row). TerminalPane hides the content of
    // that row, leaving a header title row and a blank row — matching tmux.
    const collapsed: PaneBoxInput = { x: 0, y: 3, width: 160, height: 1 };
    expect(isCollapsedPane(collapsed)).toBe(true);
    const box = computePaneBox(collapsed, CW, CH);
    expect(box.height).toBe(2 * CH);
  });

  it('does not treat a normal-height pane as collapsed', () => {
    expect(isCollapsedPane({ height: 24 })).toBe(false);
  });
});
