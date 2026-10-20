import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { connectionActions, connectionGlobalEvents } from '../connection';
import { mountState, sendAndGetContext } from '../states/__tests__/testHarness';
import type { TmuxPane } from '../../../domain/client';

const pane = {
  tmuxId: pid('%0'),
  windowId: wid('@0'),
  x: 0,
  y: 0,
  width: 120,
  height: 30,
  active: true,
} as unknown as TmuxPane;

/** Connected, holding a 120x30 grid, animations still off. */
function connected(overrides = {}) {
  return mountState(
    { on: connectionGlobalEvents },
    connectionActions,
    {},
    {
      connected: true,
      panes: [pane],
      activeWindowId: wid('@0'),
      totalWidth: 120,
      totalHeight: 30,
      enableAnimations: false,
      lastUpdateQuiet: true,
      ...overrides,
    },
  );
}

describe('the layout-animation gate, when the client measures its size', () => {
  it('opens when the grid is already that size and quiet: nothing will resize to open it later', () => {
    const ctx = sendAndGetContext(connected(), { type: 'SET_TARGET_SIZE', cols: 120, rows: 30 });
    expect(ctx.enableAnimations).toBe(true);
  });

  it('stays shut while the grid has to be resized to the size measured', () => {
    const ctx = sendAndGetContext(connected(), { type: 'SET_TARGET_SIZE', cols: 100, rows: 30 });
    expect(ctx.enableAnimations).toBe(false);
  });

  it('stays shut when the last update moved panes', () => {
    const ctx = sendAndGetContext(connected({ lastUpdateQuiet: false }), {
      type: 'SET_TARGET_SIZE',
      cols: 120,
      rows: 30,
    });
    expect(ctx.enableAnimations).toBe(false);
  });
});
