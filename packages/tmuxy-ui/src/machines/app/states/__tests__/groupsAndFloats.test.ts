import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { assign } from 'xstate';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from '../groupsAndFloats';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from '../sidebars';
import { groupsAndFloatsActions } from '../../actions/groupsAndFloats';
import { sidebarsActions } from '../../actions/sidebars';
const groupsAndFloatsGuards = {};
import { mountState, sendAndGetContext } from './testHarness';
import type { FloatPaneState } from '../../../types/domain';
import type { PaneId } from '../../../../domain/ids';

function makeFloat(paneId: PaneId, extra: Partial<FloatPaneState> = {}): FloatPaneState {
  return {
    paneId,
    parentWindowId: null,
    width: 80,
    height: 24,
    backdrop: 'dim',
    ...extra,
  };
}

// Compose the event maps and actions as appMachine spreads them, so the test
// drives the same handler set the real machine mounts.
const groupsAndFloatsState = {
  on: {
    ...groupsAndFloatsGlobalEvents,
    ...groupsAndFloatsIdleEvents,
    ...sidebarsGlobalEvents,
    ...sidebarsIdleEvents,
  },
} as const;
const combinedActions = { ...groupsAndFloatsActions, ...sidebarsActions };

describe('groupsAndFloats state', () => {
  it('CLOSE_FLOAT removes the float from floatPanes', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      floatPanes: { [pid('%1')]: makeFloat(pid('%1')), [pid('%2')]: makeFloat(pid('%2')) },
      focusedFloatPaneId: pid('%2'),
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: pid('%1') });
    expect(ctx.floatPanes[pid('%1')]).toBeUndefined();
    expect(ctx.floatPanes[pid('%2')]).toBeDefined();
    // focusedFloatPaneId untouched because closed pane wasn't focused
    expect(ctx.focusedFloatPaneId).toBe(pid('%2'));
  });

  it('CLOSE_FLOAT re-focuses next remaining float when the focused one is closed', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      floatPanes: { [pid('%1')]: makeFloat(pid('%1')), [pid('%2')]: makeFloat(pid('%2')) },
      focusedFloatPaneId: pid('%2'),
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: pid('%2') });
    expect(ctx.floatPanes[pid('%2')]).toBeUndefined();
    expect(ctx.focusedFloatPaneId).toBe(pid('%1'));
  });

  it('CLOSE_FLOAT clears focus when last float is closed', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      floatPanes: { [pid('%1')]: makeFloat(pid('%1')) },
      focusedFloatPaneId: pid('%1'),
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: pid('%1') });
    expect(ctx.focusedFloatPaneId).toBeNull();
  });

  it('CLOSE_TOP_FLOAT removes the most-recently-added float (last in object)', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      floatPanes: { [pid('%1')]: makeFloat(pid('%1')), [pid('%2')]: makeFloat(pid('%2')) },
      focusedFloatPaneId: pid('%1'),
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_TOP_FLOAT' });
    expect(ctx.floatPanes[pid('%2')]).toBeUndefined();
    expect(ctx.floatPanes[pid('%1')]).toBeDefined();
    // After closing the top (pane-2), focus moves to the next one
    expect(ctx.focusedFloatPaneId).toBe(pid('%1'));
  });

  it('CLOSE_TOP_FLOAT leaves a float that belongs to another tab alone', () => {
    // Escape closes the float the user can see. A float opened over tab @1 is
    // not on screen while tab @0 is active, so it is not the one Escape means -
    // and killing it would take a pane the user cannot even see.
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      windows: [
        { id: wid('@0'), index: 0, name: 'one', active: true, windowType: 'tab' },
        { id: wid('@1'), index: 1, name: 'two', active: false, windowType: 'tab' },
      ] as never,
      activeWindowId: wid('@0'),
      floatPanes: { [pid('%9')]: makeFloat(pid('%9'), { parentWindowId: wid('@1') }) },
      focusedFloatPaneId: null,
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_TOP_FLOAT' });
    expect(ctx.floatPanes[pid('%9')]).toBeDefined();
  });

  it('CLOSE_TOP_FLOAT no-ops when there are no floats', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, groupsAndFloatsGuards, {
      floatPanes: {},
      focusedFloatPaneId: null,
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_TOP_FLOAT' });
    expect(ctx.floatPanes).toEqual({});
    expect(ctx.focusedFloatPaneId).toBeNull();
  });

  describe('sidebar toggles', () => {
    // The toggles also handle SET_TARGET_SIZE here so the test can see the
    // size they ask for (appMachine owns the real handler).
    const withSizeRecorder = {
      on: { ...groupsAndFloatsState.on, SET_TARGET_SIZE: { actions: 'recordTargetSize' } },
    } as const;
    const actions = {
      ...combinedActions,
      recordTargetSize: assign(({ event }) => {
        const size = event as unknown as { cols: number; rows: number };
        return { targetCols: size.cols, targetRows: size.rows };
      }),
    };
    // A 1000px body, 10px cells, 24px rows: the grid is 100 cols wide with
    // nothing docked and 35 narrower once the 35-col dock is open.
    const measured = {
      bodyWidth: 1000 + 24,
      containerWidth: 1000,
      containerHeight: 480,
      charWidth: 10,
      measuredCell: { charWidth: 10, charHeight: 24, cellGap: 0, gridFontSize: null },
      baseFontSize: 15,
      targetCols: 100,
      targetRows: 20,
    };

    it('opening the dock sizes the grid for it at once', () => {
      const actor = mountState(withSizeRecorder, actions, groupsAndFloatsGuards, measured);
      const ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
      expect(ctx.rightSidebarOpen).toBe(true);
      // 35 dock columns in the 12px sidebar font (8px cells) leave the grid
      // 1000 - 280 = 720px, 72 columns.
      expect(ctx.targetCols).toBe(72);
    });

    it('closing it gives the grid its width back at once', () => {
      const actor = mountState(withSizeRecorder, actions, groupsAndFloatsGuards, {
        ...measured,
        rightSidebarOpen: true,
        targetCols: 72,
      });
      const ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
      expect(ctx.rightSidebarOpen).toBe(false);
      expect(ctx.targetCols).toBe(100);
    });
  });
});
