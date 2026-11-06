/**
 * P1 on the tab strip: a placeholder tab — a predicted new window tmux has
 * not named yet — never has its id sent to tmux. tmux is
 * already on the window it stands for (a new window is selected as it is
 * made), and `select-window -t __placeholder…` is an error that, pinned
 * ahead of a kill-window, also stops the kill.
 */
import { describe, it, expect } from 'vitest';
import { layoutState } from '../layout';
import { layoutActions } from '../../actions/layout';
import { TmuxOp } from '../../../../domain/commands';
import { placeholderPaneId, placeholderWindowId } from '../../../../domain/ids';
import { pid, wid } from '../../../../test/wire';
import { recorder } from '../../../../test/app';
import type { AppMachineContext } from '../../../types/context';
import { mountState, sendAndGetContext } from './testHarness';

/** The layout slice over a recording store; returns it and the ops that reached the store. */
function mountSelectTab(context: Partial<AppMachineContext>) {
  const store = recorder();
  const actor = mountState(layoutState, layoutActions, context, {
    extraActors: { tmuxStore: store.logic },
  });
  return { actor, sent: store.ops };
}

describe('SELECT_TAB', () => {
  it('hands the switch to the store, which predicts it; the machine assigns nothing itself', () => {
    const { actor, sent } = mountSelectTab({ activeWindowId: wid('@0') });
    const ctx = sendAndGetContext(actor, { type: 'SELECT_TAB', windowId: wid('@1') });
    expect(sent()).toEqual([TmuxOp.SelectWindow({ target: wid('@1') })]);
    expect(ctx.activeWindowId).toBe(wid('@0'));
  });

  it('sends nothing when already on the target window', () => {
    const { actor, sent } = mountSelectTab({ activeWindowId: wid('@5'), windows: [] });
    actor.send({ type: 'SELECT_TAB', windowId: wid('@5') });
    expect(sent()).toEqual([]);
  });
});

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

  it('never names a placeholder tab to tmux', () => {
    const { actor, sent } = mountSelectTab({
      activeWindowId: wid('@1'),
      activePaneId: pid('%1'),
      windows,
      panes,
    } as never);
    actor.send({ type: 'SELECT_TAB', windowId: placeholder });
    expect(sent()).toEqual([]);
  });

  it('names a real tab to tmux as before', () => {
    const { actor, sent } = mountSelectTab({
      activeWindowId: placeholder,
      activePaneId: placeholderPane,
      windows,
      panes,
    } as never);
    actor.send({ type: 'SELECT_TAB', windowId: wid('@1') });
    expect(sent()).toEqual([TmuxOp.SelectWindow({ target: wid('@1') })]);
  });
});
