/**
 * `@tmuxy-size` in the machine: what this client asks tmux for, and the cell
 * its grid is drawn in.
 */
import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { connectionActions, connectionGlobalEvents } from '../connection';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from '../states/sidebars';
import { sidebarsActions } from '../actions/sidebars';
import { mountState, sendAndGetContext } from '../states/__tests__/testHarness';
import type { TmuxPane } from '../../../domain/client';
import type { SizePolicy } from '../../../domain/wire';

const measuredCell = { charWidth: 10, charHeight: 24, cellGap: 0, gridFontSize: null };

function gridPane(width: number, height: number) {
  return {
    tmuxId: pid('%0'),
    windowId: wid('@0'),
    x: 0,
    y: 0,
    width,
    height,
    active: true,
  } as unknown as TmuxPane;
}

/** A 1000x480 container of 10x24 cells holding a `grid`, under `sizePolicy`. */
function client(sizePolicy: SizePolicy, grid = { cols: 100, rows: 20 }) {
  return mountState(
    { on: { ...connectionGlobalEvents, ...sidebarsGlobalEvents, ...sidebarsIdleEvents } },
    { ...connectionActions, ...sidebarsActions },
    {},
    {
      connected: true,
      sizePolicy,
      panes: [gridPane(grid.cols, grid.rows)],
      activeWindowId: wid('@0'),
      totalWidth: grid.cols,
      totalHeight: grid.rows,
      bodyWidth: 1024,
      containerWidth: 1000,
      containerHeight: 480,
      baseFontSize: 15,
      measuredCell,
      charWidth: 10,
      charHeight: 24,
      targetCols: 100,
      targetRows: 20,
    },
  );
}

describe('@tmuxy-size', () => {
  it('a fixed size is what the client asks for, whatever its container measures', () => {
    const ctx = sendAndGetContext(client({ mode: 'fixed', cols: 80, rows: 25 }), {
      type: 'SET_TARGET_SIZE',
      cols: 100,
      rows: 20,
    });
    expect([ctx.targetCols, ctx.targetRows]).toEqual([80, 25]);
  });

  it('a fixed size keeps its cols/rows when a sidebar opens, and the grid is scaled instead', () => {
    const actor = client({ mode: 'fixed', cols: 100, rows: 20 });
    let ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
    expect(ctx.rightSidebarOpen).toBe(true);
    expect([ctx.targetCols, ctx.targetRows]).toEqual([100, 20]);

    // The column takes 280px of the container: the grid is fitted to what is left.
    ctx = sendAndGetContext(actor, { type: 'SET_CONTAINER_SIZE', width: 720, height: 480 });
    expect(ctx.charWidth).toBeCloseTo(7.2);
    expect(100 * ctx.charWidth).toBeLessThanOrEqual(720);
    expect(ctx.gridFontSize).not.toBeNull();
    // The column itself is chrome, laid out in the measured cell.
    expect(ctx.measuredCell).toEqual(measuredCell);
  });

  it('smallest asks for what the container holds and draws the measured cell', () => {
    const actor = client({ mode: 'smallest' });
    let ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
    expect(ctx.targetCols).toBe(72);
    ctx = sendAndGetContext(actor, { type: 'SET_CONTAINER_SIZE', width: 720, height: 480 });
    expect(ctx.charWidth).toBe(10);
    expect(ctx.gridFontSize).toBeNull();
  });

  it('a largest grid wider than this client is drawn in a cell that fits it', () => {
    const actor = client({ mode: 'largest' }, { cols: 200, rows: 20 });
    const ctx = sendAndGetContext(actor, { type: 'REFIT_GRID' });
    expect(ctx.charWidth).toBe(5);
    expect(ctx.targetCols).toBe(100);
  });
});
