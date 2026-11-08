/**
 * A sidebar column is one tmux window. Toggling it while the window is still
 * being made used to ask tmux for another, and every extra window lived on
 * hidden for good: six fast toggles left three sidebar windows a side.
 */
import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { recorder, startApp } from '../../../../test/app';
import type { AppMachineContext } from '../../../types/context';

/** The app over `context` and a recording tmux actor; returns it and the ops sent. */
function mountSidebars(context: Partial<AppMachineContext>) {
  const tmux = recorder();
  const actor = startApp({ context, actors: { tmuxActor: tmux.logic } });
  return { actor, sent: tmux.ops };
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
    for (let i = 0; i < 6; i++) actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    const opens = sent().filter((op) => op._tag === 'OpenSidebar');
    expect(opens).toHaveLength(1);
    expect(actor.getSnapshot().context.sidebars.left.starting).toBe(true);
    // An even number of toggles: the user wants it closed when it lands.
    expect(actor.getSnapshot().context.sidebars.left.open).toBe(false);
  });

  it('asks tmux for one right column too', () => {
    const { actor, sent } = mountSidebars(noSidebar);
    for (let i = 0; i < 5; i++) actor.send({ type: 'TOGGLE_SIDEBAR', side: 'right' });
    expect(sent().filter((op) => op._tag === 'OpenSidebar')).toHaveLength(1);
    expect(actor.getSnapshot().context.sidebars.right.open).toBe(true);
  });

  it('asks again once the first attempt has timed out', () => {
    const { actor, sent } = mountSidebars(noSidebar);
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    actor.send({ type: 'SIDEBAR_START_TIMEOUT', side: 'left' });
    actor.send({ type: 'TOGGLE_SIDEBAR', side: 'left' });
    expect(sent().filter((op) => op._tag === 'OpenSidebar')).toHaveLength(2);
  });
});
