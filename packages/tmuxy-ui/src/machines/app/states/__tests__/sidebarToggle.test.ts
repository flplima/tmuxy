/**
 * A sidebar column is one tmux window. Toggling it while the window is still
 * being made used to ask tmux for another, and every extra window lived on
 * hidden for good: six fast toggles left three sidebar windows a side.
 */
import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { sidebarsActions } from '../../actions/sidebars';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from '../sidebars';
import type { TmuxOp } from '../../../../domain/commands';
import { pid, wid } from '../../../../test/wire';
import type { AppMachineContext } from '../../../types/context';
import { mountState } from './testHarness';

const sidebarState = { on: { ...sidebarsGlobalEvents, ...sidebarsIdleEvents } };

/** The sidebar slice over a recording tmux actor; returns the ops sent. */
function mountSidebars(context: Partial<AppMachineContext>) {
  const sent: TmuxOp[] = [];
  const tmux = fromCallback(({ receive }) => {
    receive((event) => {
      const e = event as unknown as { type: string; op?: TmuxOp };
      if (e.type === 'SEND_OP' && e.op) sent.push(e.op);
    });
  });
  // Opening the tree column also asks the servers actor for a refresh.
  const servers = fromCallback(() => () => {});
  const actor = mountState(sidebarState, sidebarsActions, {}, context, {
    extraActors: { tmux, servers },
  });
  return { actor, sent };
}

const noSidebar = {
  activePaneId: pid('%1'),
  activeWindowId: wid('@1'),
  windows: [{ id: wid('@1'), index: 1, name: 'one', active: true, windowType: 'tab' }],
  panes: [
    { tmuxId: pid('%1'), windowId: wid('@1'), active: true, x: 0, y: 0, width: 80, height: 24 },
  ],
} as never;

describe('toggling a sidebar whose window is still being made', () => {
  it('asks tmux for one left column, however fast the toggles come', () => {
    const { actor, sent } = mountSidebars(noSidebar);
    for (let i = 0; i < 6; i++) actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    const opens = sent.filter((op) => op._tag === 'OpenSidebar');
    expect(opens).toHaveLength(1);
    expect(actor.getSnapshot().context.leftSidebarStarting).toBe(true);
    // An even number of toggles: the user wants it closed when it lands.
    expect(actor.getSnapshot().context.leftSidebarOpen).toBe(false);
  });

  it('asks tmux for one right column too', () => {
    const { actor, sent } = mountSidebars(noSidebar);
    for (let i = 0; i < 5; i++) actor.send({ type: 'TOGGLE_RIGHT_SIDEBAR' });
    expect(sent.filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
    expect(actor.getSnapshot().context.rightSidebarOpen).toBe(true);
  });

  it('asks again once the first attempt has timed out', () => {
    const { actor, sent } = mountSidebars(noSidebar);
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    actor.send({ type: 'SIDEBAR_START_TIMEOUT', side: 'left' });
    actor.send({ type: 'TOGGLE_LEFT_SIDEBAR' });
    expect(sent.filter((op) => op._tag === 'OpenSidebar')).toHaveLength(2);
  });
});
