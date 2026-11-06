import { beforeEach, describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { assign } from 'xstate';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from '../groupsAndFloats';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from '../sidebars';
import { groupsAndFloatsActions } from '../../actions/groupsAndFloats';
import { sidebarsActions } from '../../actions/sidebars';
import { keyboardGlobalEvents } from '../keyboard';
import { keyboardActions } from '../../actions/keyboard';
import { selectFocusedFloat } from '../../../selectors/keyboard';
import { TmuxOp } from '../../../../domain/commands';
import { sidebarsOpen } from '../../../../test/model';
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
// drives the same handler set the real machine mounts. The ops a close
// dispatches are recorded, as the store would receive them.
const dispatched: TmuxOp[] = [];
const groupsAndFloatsState = {
  on: {
    ...groupsAndFloatsGlobalEvents,
    ...groupsAndFloatsIdleEvents,
    ...sidebarsGlobalEvents,
    ...sidebarsIdleEvents,
    ...keyboardGlobalEvents,
    DISPATCH_OP: { actions: 'recordOp' },
  },
} as const;
const combinedActions = {
  ...groupsAndFloatsActions,
  ...sidebarsActions,
  ...keyboardActions,
  recordOp: ({ event }: { event: { op: TmuxOp } }) => void dispatched.push(event.op),
};

const twoFloats = {
  floatPanes: { [pid('%1')]: makeFloat(pid('%1')), [pid('%2')]: makeFloat(pid('%2')) },
};
const floatOwner = (paneId: PaneId) => ({ kind: 'float' as const, paneId });

describe('groupsAndFloats state', () => {
  beforeEach(() => {
    dispatched.length = 0;
  });

  it('CLOSE_FLOAT kills the float’s pane through the store', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, {}, twoFloats);
    actor.send({ type: 'CLOSE_FLOAT', paneId: pid('%1') });
    expect(dispatched).toEqual([TmuxOp.KillPane({ paneId: pid('%1') })]);
  });

  it('CLOSE_TOP_FLOAT closes the most-recently-added float (last in object)', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, {}, twoFloats);
    actor.send({ type: 'CLOSE_TOP_FLOAT' });
    expect(dispatched).toEqual([TmuxOp.KillPane({ paneId: pid('%2') })]);
  });

  it('CLOSE_TOP_FLOAT leaves a float that belongs to another tab alone', () => {
    // Escape closes the float the user can see. A float opened over tab @1 is
    // not on screen while tab @0 is active, so it is not the one Escape means -
    // and killing it would take a pane the user cannot even see.
    const actor = mountState(
      groupsAndFloatsState,
      combinedActions,
      {},
      {
        windows: [
          { id: wid('@0'), index: 0, name: 'one', active: true, windowType: 'tab' },
          { id: wid('@1'), index: 1, name: 'two', active: false, windowType: 'tab' },
        ] as never,
        activeWindowId: wid('@0'),
        floatPanes: { [pid('%9')]: makeFloat(pid('%9'), { parentWindowId: wid('@1') }) },
      },
    );
    actor.send({ type: 'CLOSE_TOP_FLOAT' });
    expect(dispatched).toEqual([]);
  });

  it('CLOSE_TOP_FLOAT no-ops when there are no floats', () => {
    const actor = mountState(groupsAndFloatsState, combinedActions, {}, { floatPanes: {} });
    actor.send({ type: 'CLOSE_TOP_FLOAT' });
    expect(dispatched).toEqual([]);
  });

  describe('the keyboard as the floats on screen change', () => {
    it('a float that holds it and goes hands it to the topmost one left', () => {
      const actor = mountState(
        groupsAndFloatsState,
        combinedActions,
        {},
        {
          floatPanes: { [pid('%1')]: makeFloat(pid('%1')) },
          keyboardOwner: floatOwner(pid('%2')),
        },
      );
      const ctx = sendAndGetContext(actor, { type: 'SYNC_FLOAT_FOCUS', claim: false });
      expect(selectFocusedFloat(ctx)).toBe(pid('%1'));
    });

    it('the last float going gives it back to the panes', () => {
      const actor = mountState(
        groupsAndFloatsState,
        combinedActions,
        {},
        {
          floatPanes: {},
          keyboardOwner: floatOwner(pid('%1')),
        },
      );
      const ctx = sendAndGetContext(actor, { type: 'SYNC_FLOAT_FOCUS', claim: false });
      expect(ctx.keyboardOwner).toEqual({ kind: 'panes' });
    });

    it('a float that keeps it, or a column that holds it, is left alone without a claim', () => {
      const actor = mountState(
        groupsAndFloatsState,
        combinedActions,
        {},
        {
          ...twoFloats,
          keyboardOwner: floatOwner(pid('%1')),
        },
      );
      expect(
        selectFocusedFloat(sendAndGetContext(actor, { type: 'SYNC_FLOAT_FOCUS', claim: false })),
      ).toBe(pid('%1'));
      const tree = { kind: 'left' as const, paneId: pid('%7') };
      const column = mountState(
        groupsAndFloatsState,
        combinedActions,
        {},
        {
          ...twoFloats,
          keyboardOwner: tree,
        },
      );
      expect(
        sendAndGetContext(column, { type: 'SYNC_FLOAT_FOCUS', claim: false }).keyboardOwner,
      ).toEqual(tree);
    });

    it('a claim gives it to the topmost float', () => {
      const actor = mountState(
        groupsAndFloatsState,
        combinedActions,
        {},
        {
          ...twoFloats,
          keyboardOwner: { kind: 'left', paneId: pid('%7') },
        },
      );
      const ctx = sendAndGetContext(actor, { type: 'SYNC_FLOAT_FOCUS', claim: true });
      expect(selectFocusedFloat(ctx)).toBe(pid('%2'));
    });
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
      const actor = mountState(withSizeRecorder, actions, {}, measured);
      const ctx = sendAndGetContext(actor, { type: 'TOGGLE_SIDEBAR', side: 'right' });
      expect(ctx.sidebars.right.open).toBe(true);
      // 35 dock columns in the 12px sidebar font (8px cells) leave the grid
      // 1000 - 280 = 720px, 72 columns.
      expect(ctx.targetCols).toBe(72);
    });

    it('closing it gives the grid its width back at once', () => {
      const actor = mountState(
        withSizeRecorder,
        actions,
        {},
        {
          ...measured,
          sidebars: sidebarsOpen({ right: true }),
          targetCols: 72,
        },
      );
      const ctx = sendAndGetContext(actor, { type: 'TOGGLE_SIDEBAR', side: 'right' });
      expect(ctx.sidebars.right.open).toBe(false);
      expect(ctx.targetCols).toBe(100);
    });
  });
});
