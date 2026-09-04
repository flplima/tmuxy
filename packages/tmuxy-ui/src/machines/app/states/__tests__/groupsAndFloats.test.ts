import { describe, it, expect, vi } from 'vitest';
import { assign } from 'xstate';
import { groupsAndFloatsGlobalEvents, groupsAndFloatsIdleEvents } from '../groupsAndFloats';
import { groupsAndFloatsActions } from '../../actions/groupsAndFloats';
import { SIDEBAR_MOTION_SETTLE_MS } from '../../../constants';
const groupsAndFloatsGuards = {};
import { mountState, sendAndGetContext } from './testHarness';
import type { FloatPaneState } from '../../../types';

function makeFloat(paneId: string, extra: Partial<FloatPaneState> = {}): FloatPaneState {
  return {
    paneId,
    width: 80,
    height: 24,
    backdrop: 'dim',
    ...extra,
  };
}

// Compose the two event maps exactly as appMachine spreads them, so the test
// drives the same handler set the real machine mounts.
const groupsAndFloatsState = {
  on: { ...groupsAndFloatsGlobalEvents, ...groupsAndFloatsIdleEvents },
} as const;

describe('groupsAndFloats state', () => {
  it('CLOSE_FLOAT removes the float from floatPanes', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      floatPanes: { 'pane-1': makeFloat('pane-1'), 'pane-2': makeFloat('pane-2') },
      focusedFloatPaneId: 'pane-2',
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: 'pane-1' });
    expect(ctx.floatPanes['pane-1']).toBeUndefined();
    expect(ctx.floatPanes['pane-2']).toBeDefined();
    // focusedFloatPaneId untouched because closed pane wasn't focused
    expect(ctx.focusedFloatPaneId).toBe('pane-2');
  });

  it('CLOSE_FLOAT re-focuses next remaining float when the focused one is closed', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      floatPanes: { 'pane-1': makeFloat('pane-1'), 'pane-2': makeFloat('pane-2') },
      focusedFloatPaneId: 'pane-2',
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: 'pane-2' });
    expect(ctx.floatPanes['pane-2']).toBeUndefined();
    expect(ctx.focusedFloatPaneId).toBe('pane-1');
  });

  it('CLOSE_FLOAT clears focus when last float is closed', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      floatPanes: { 'pane-1': makeFloat('pane-1') },
      focusedFloatPaneId: 'pane-1',
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_FLOAT', paneId: 'pane-1' });
    expect(ctx.focusedFloatPaneId).toBeNull();
  });

  it('CLOSE_TOP_FLOAT removes the most-recently-added float (last in object)', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      floatPanes: { 'pane-1': makeFloat('pane-1'), 'pane-2': makeFloat('pane-2') },
      focusedFloatPaneId: 'pane-1',
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_TOP_FLOAT' });
    expect(ctx.floatPanes['pane-2']).toBeUndefined();
    expect(ctx.floatPanes['pane-1']).toBeDefined();
    // After closing the top (pane-2), focus moves to the next one
    expect(ctx.focusedFloatPaneId).toBe('pane-1');
  });

  it('CLOSE_TOP_FLOAT no-ops when there are no floats', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      floatPanes: {},
      focusedFloatPaneId: null,
    });
    const ctx = sendAndGetContext(actor, { type: 'CLOSE_TOP_FLOAT' });
    expect(ctx.floatPanes).toEqual({});
    expect(ctx.focusedFloatPaneId).toBeNull();
  });

  it('OPEN_SESSION_FLOAT does not crash and leaves context unchanged', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards);
    const before = actor.getSnapshot().context.floatPanes;
    const ctx = sendAndGetContext(actor, { type: 'OPEN_SESSION_FLOAT' });
    expect(ctx.floatPanes).toBe(before);
  });

  describe('sidebar motion', () => {
    // The toggles also handle SET_TARGET_SIZE here so the test can see the
    // settled size the motion predicts (appMachine owns the real handler).
    const withSizeRecorder = {
      on: { ...groupsAndFloatsState.on, SET_TARGET_SIZE: { actions: 'recordTargetSize' } },
    } as const;
    const actions = {
      ...groupsAndFloatsActions,
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
      baseFontSize: 15,
      targetCols: 100,
      targetRows: 20,
    };

    it('opening the dock sizes the grid for the settled layout at once and settles after the slide', () => {
      vi.useFakeTimers();
      try {
        const actor = mountState(withSizeRecorder, actions, groupsAndFloatsGuards, measured);
        let ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
        expect(ctx.rightSidebarOpen).toBe(true);
        expect(ctx.sidebarMotion).toBe(true);
        expect(ctx.rightSidebarClosing).toBe(false);
        // 35 dock columns in the 12px sidebar font (8px cells) leave the grid
        // 1000 - 280 = 720px, 72 columns.
        expect(ctx.targetCols).toBe(72);

        vi.advanceTimersByTime(SIDEBAR_MOTION_SETTLE_MS + 1);
        ctx = actor.getSnapshot().context;
        expect(ctx.sidebarMotion).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closing keeps the column rendered as closing until the slide settles, then drops it', () => {
      vi.useFakeTimers();
      try {
        const actor = mountState(withSizeRecorder, actions, groupsAndFloatsGuards, {
          ...measured,
          rightSidebarOpen: true,
        });
        let ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
        expect(ctx.rightSidebarOpen).toBe(false);
        expect(ctx.rightSidebarClosing).toBe(true);
        expect(ctx.sidebarMotion).toBe(true);
        expect(ctx.targetCols).toBe(100);

        // Reopening mid-slide reverses it without a settle in between.
        ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
        expect(ctx.rightSidebarOpen).toBe(true);
        expect(ctx.rightSidebarClosing).toBe(false);
        expect(ctx.sidebarMotion).toBe(true);

        ctx = sendAndGetContext(actor, { type: 'TOGGLE_RIGHT_SIDEBAR' });
        expect(ctx.rightSidebarClosing).toBe(true);
        vi.advanceTimersByTime(SIDEBAR_MOTION_SETTLE_MS - 10);
        expect(actor.getSnapshot().context.rightSidebarClosing).toBe(true);
        vi.advanceTimersByTime(20);
        ctx = actor.getSnapshot().context;
        expect(ctx.rightSidebarClosing).toBe(false);
        expect(ctx.sidebarMotion).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
