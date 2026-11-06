/**
 * The active pane is the current window's.
 *
 * tmux names no active pane while a window it has just made current has none
 * listed yet: five tabs opened at once, typing straight after, the new tabs
 * still in flight. The pane this client had was held through that from the
 * window left behind, so the keys went to a pane of a hidden tab and nothing
 * on screen showed them.
 */

import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { startApp } from '../../../test/app';
import type { TmuxPane } from '../../../domain/client';
import type { OpId } from '../../../domain/store/types';
import { makePendingOp } from '../../../domain/store/model';
import { TmuxOp } from '../../../domain/commands';
import type { PaneId, WindowId } from '../../../domain/ids';

const ONE = wid('@1');
const TWO = wid('@2');

const pane = (tmuxId: PaneId, windowId: WindowId, width = 80) =>
  modelPane(tmuxId, windowId, { width, height: 23, y: 1, active: true, historySize: 500 });

const tab = (id: WindowId, index: number, active: boolean) =>
  modelWindow(id, index, { name: `tab${index}`, active });

/** A new tab tmux has not confirmed yet. */
const newTab = makePendingOp({
  id: 'op_new_tab' as OpId,
  op: TmuxOp.NewWindow(),
  command: 'splitw ; breakp',
  patch: (s) => s,
  meta: {},
});

/** A model update from tmux, with a new tab in flight or nothing. */
const update = (
  activeWindowId: WindowId,
  activePaneId: PaneId | null,
  panes: TmuxPane[],
  inFlight = false,
) =>
  modelUpdate(
    panes,
    [tab(ONE, 0, activeWindowId === ONE), tab(TWO, 1, activeWindowId === TWO)],
    { paneId: activePaneId, windowId: activeWindowId },
    { ops: inFlight ? [newTab] : [] },
  );

const onTabOne = () => {
  const actor = startApp();
  actor.send(update(ONE, pid('%1'), [pane(pid('%1'), ONE)]));
  expect(actor.getSnapshot().context.activePaneId).toBe(pid('%1'));
  return actor;
};

describe('the active pane across a window switch', () => {
  it('is none when tmux has made a window current whose panes are not listed yet', () => {
    const actor = onTabOne();
    actor.send(update(TWO, null, [pane(pid('%1'), ONE)], true));
    expect(actor.getSnapshot().context.activeWindowId).toBe(TWO);
    expect(actor.getSnapshot().context.activePaneId).toBeNull();
  });

  it('is still the pane this client had when that pane is in the current window', () => {
    const actor = onTabOne();
    actor.send(update(ONE, null, [pane(pid('%1'), ONE)], true));
    expect(actor.getSnapshot().context.activePaneId).toBe(pid('%1'));
  });

  it('is the one tmux names in the window it switched to, while panes resize', () => {
    const actor = startApp();
    actor.send(update(ONE, pid('%1'), [pane(pid('%1'), ONE), pane(pid('%2'), TWO)]));
    // The same panes, one of them resized.
    actor.send(update(TWO, pid('%2'), [pane(pid('%1'), ONE, 40), pane(pid('%2'), TWO)], true));
    expect(actor.getSnapshot().context.activeWindowId).toBe(TWO);
    expect(actor.getSnapshot().context.activePaneId).toBe(pid('%2'));
  });
});
