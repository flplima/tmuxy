import { describe, it, expect } from 'vitest';
import { groupsAndFloatsState } from '../groupsAndFloats';
import { groupsAndFloatsActions } from '../../actions/groupsAndFloats';
import { groupsAndFloatsGuards } from '../../guards/groupsAndFloats';
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

  it('CLEAR_GROUP_SWITCH_OVERRIDE keeps fresh entries (<750ms old)', () => {
    const fresh = {
      paneId: 'p1',
      fromPaneId: 'p2',
      x: 0, y: 0, width: 80, height: 24,
      timestamp: Date.now() - 200,
    };
    const stale = {
      paneId: 'p3',
      fromPaneId: 'p4',
      x: 0, y: 0, width: 80, height: 24,
      timestamp: Date.now() - 1000,
    };
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards, {
      groupSwitchDimOverrides: [fresh, stale],
    });
    const ctx = sendAndGetContext(actor, { type: 'CLEAR_GROUP_SWITCH_OVERRIDE' });
    expect(ctx.groupSwitchDimOverrides).toHaveLength(1);
    expect(ctx.groupSwitchDimOverrides[0].paneId).toBe('p1');
  });

  it('OPEN_SESSION_FLOAT does not crash and leaves context unchanged', () => {
    const actor = mountState(groupsAndFloatsState, groupsAndFloatsActions, groupsAndFloatsGuards);
    const before = actor.getSnapshot().context.floatPanes;
    const ctx = sendAndGetContext(actor, { type: 'OPEN_SESSION_FLOAT' });
    expect(ctx.floatPanes).toBe(before);
  });
});
