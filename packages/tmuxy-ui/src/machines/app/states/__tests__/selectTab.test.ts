/**
 * P1 on the tab strip: a placeholder tab — a predicted new window tmux has
 * not named yet — can be switched to, but its id never goes to tmux. tmux is
 * already on the window it stands for (a new window is selected as it is
 * made), and `select-window -t __placeholder…` is an error that, pinned
 * ahead of a kill-window, also stops the kill.
 */
import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { layoutActions } from '../../actions/layout';
import { TmuxOp } from '../../../../domain/commands';
import { placeholderPaneId, placeholderWindowId } from '../../../../domain/ids';
import { pid, wid } from '../../../../test/wire';
import type { AppMachineContext } from '../../../types/context';
import { mountState } from './testHarness';

const selectTabState = { on: { SELECT_TAB: { actions: 'layout_selectTab' } } };

/** The tab-select action over a recording store; returns the ops that reached it. */
function mountSelectTab(context: Partial<AppMachineContext>) {
  const sent: TmuxOp[] = [];
  const tmuxStore = fromCallback(({ receive }) => {
    receive((event) => {
      sent.push((event as unknown as { op: TmuxOp }).op);
    });
  });
  const actor = mountState(selectTabState, layoutActions, {}, context, {
    extraActors: { tmuxStore },
  });
  return { actor, sent };
}

describe('SELECT_TAB while a new tab is still predicted', () => {
  const placeholder = placeholderWindowId('op1');
  const placeholderPane = placeholderPaneId('pane_op1');
  const windows = [
    { id: wid('@1'), index: 1, name: 'one', active: true, windowType: 'tab' },
    { id: placeholder, index: 2, name: 'Window 2', active: false, windowType: 'tab' },
  ];
  const panes = [
    { tmuxId: pid('%1'), windowId: wid('@1'), active: true, x: 0, y: 0, width: 80, height: 24 },
    {
      tmuxId: placeholderPane,
      windowId: placeholder,
      active: false,
      x: 0,
      y: 0,
      width: 80,
      height: 24,
    },
  ];

  it('switches the view to a placeholder tab without naming it to tmux', () => {
    const { actor, sent } = mountSelectTab({
      activeWindowId: wid('@1'),
      activePaneId: pid('%1'),
      windows,
      panes,
    } as never);
    actor.send({ type: 'SELECT_TAB', windowId: placeholder });
    expect(actor.getSnapshot().context.activeWindowId).toBe(placeholder);
    expect(actor.getSnapshot().context.activePaneId).toBe(placeholderPane);
    expect(sent).toEqual([]);
  });

  it('names a real tab to tmux as before', () => {
    const { actor, sent } = mountSelectTab({
      activeWindowId: placeholder,
      activePaneId: placeholderPane,
      windows,
      panes,
    } as never);
    actor.send({ type: 'SELECT_TAB', windowId: wid('@1') });
    expect(actor.getSnapshot().context.activeWindowId).toBe(wid('@1'));
    expect(sent).toEqual([TmuxOp.SelectWindow({ target: wid('@1') })]);
  });
});
