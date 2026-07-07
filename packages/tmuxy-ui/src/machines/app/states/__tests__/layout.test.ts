import { describe, it, expect } from 'vitest';
import { layoutState } from '../layout';
import { layoutActions } from '../../actions/layout';
import { layoutGuards } from '../../guards/layout';
import { mountState, sendAndGetContext } from './testHarness';
import type { ResizeState } from '../../../types';

describe('layout state', () => {
  it('SELECT_TAB flips activeWindowId and computes optimistic activePaneId', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      activeWindowId: '@0',
      activePaneId: '%0',
      windows: [
        {
          id: '@0',
          index: 0,
          name: 'a',
          active: true,
          windowType: 'tab',
          groupPanes: null,
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
        {
          id: '@1',
          index: 1,
          name: 'b',
          active: false,
          windowType: 'tab',
          groupPanes: null,
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      panes: [
        {
          id: 0,
          tmuxId: '%0',
          windowId: '@0',
          content: [],
          cursorX: 0,
          cursorY: 0,
          width: 80,
          height: 24,
          x: 0,
          y: 0,
          active: true,
          command: 'bash',
          title: '',
          borderTitle: '',
          inMode: false,
          copyCursorX: 0,
          copyCursorY: 0,
          alternateOn: false,
          mouseAnyFlag: false,
          paused: false,
          historySize: 0,
          selectionPresent: false,
          selectionStartX: 0,
          selectionStartY: 0,
          cursorShape: 0,
          cursorHidden: false,
        },
        {
          id: 1,
          tmuxId: '%1',
          windowId: '@1',
          content: [],
          cursorX: 0,
          cursorY: 0,
          width: 80,
          height: 24,
          x: 0,
          y: 0,
          active: true,
          command: 'bash',
          title: '',
          borderTitle: '',
          inMode: false,
          copyCursorX: 0,
          copyCursorY: 0,
          alternateOn: false,
          mouseAnyFlag: false,
          paused: false,
          historySize: 0,
          selectionPresent: false,
          selectionStartX: 0,
          selectionStartY: 0,
          cursorShape: 0,
          cursorHidden: false,
        },
      ],
    });
    const ctx = sendAndGetContext(actor, {
      type: 'SELECT_TAB',
      windowId: '@1',
      windowIndex: 1,
    });
    expect(ctx.activeWindowId).toBe('@1');
    expect(ctx.activePaneId).toBe('%1');
    // Outgoing window's active pane was recorded for restore-on-return
    expect(ctx.lastActivePaneByWindow['@0']).toBe('%0');
  });

  it('SELECT_TAB is a no-op when already on the target window', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      activeWindowId: '@5',
      windows: [],
    });
    const ctx = sendAndGetContext(actor, {
      type: 'SELECT_TAB',
      windowId: '@5',
      windowIndex: 5,
    });
    // No flip and no dispatch — active window unchanged.
    expect(ctx.activeWindowId).toBe('@5');
  });

  it('RESIZE_STATE_UPDATE writes resize and resizeActive flag', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      resize: null,
      resizeActive: false,
    });
    // Casting via unknown — the test only cares about the assign behavior,
    // not the shape of the resize payload itself (covered elsewhere).
    const resize = { paneId: '%1', handle: 'e' } as unknown as ResizeState;
    let ctx = sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize });
    expect(ctx.resize).toEqual(resize);
    expect(ctx.resizeActive).toBe(true);
    ctx = sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize: null });
    expect(ctx.resizeActive).toBe(false);
  });

  it('CLEAR_LAYOUT_TRANSITION_SUPPRESSION sets suppressLayoutTransition to false', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      suppressLayoutTransition: true,
    });
    const ctx = sendAndGetContext(actor, { type: 'CLEAR_LAYOUT_TRANSITION_SUPPRESSION' });
    expect(ctx.suppressLayoutTransition).toBe(false);
  });

  it('DRAG_STATE_UPDATE assigns the drag field directly', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      drag: null,
    });
    const ctx = sendAndGetContext(actor, { type: 'DRAG_STATE_UPDATE', drag: null });
    expect(ctx.drag).toBeNull();
  });
});
