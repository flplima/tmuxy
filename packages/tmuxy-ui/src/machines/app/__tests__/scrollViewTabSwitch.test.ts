/**
 * Leaving a tab closes the scroll views on it.
 *
 * A scroll view is the client's own: tmux knows nothing of it, and it hides
 * the pane's live screen behind old history. Left open on a tab the user
 * switched away from, it held that pane on what they had scrolled to while its
 * program kept printing, and the tab came back to it. Copy mode is tmux's, so
 * it stays.
 */

import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { startApp } from '../../../test/app';
import type { TmuxPane } from '../../../domain/client';
import type { PaneId, WindowId } from '../../../domain/ids';

const ONE = wid('@1');
const TWO = wid('@2');

const pane = (tmuxId: PaneId, windowId: WindowId, inMode = false) =>
  modelPane(tmuxId, windowId, { height: 23, y: 1, active: true, inMode, historySize: 500 });

const tab = (id: WindowId, index: number, active: boolean) =>
  modelWindow(id, index, { name: `tab${index}`, active });

/** A model update with `activeWindowId` the current tab, nothing optimistic in flight. */
const showing = (activeWindowId: WindowId, panes: TmuxPane[]) =>
  modelUpdate(panes, [tab(ONE, 0, activeWindowId === ONE), tab(TWO, 1, activeWindowId === TWO)], {
    paneId: activeWindowId === ONE ? pid('%1') : pid('%2'),
    windowId: activeWindowId,
  });

const connected = (panes: TmuxPane[]) => {
  const actor = startApp();
  actor.send(showing(ONE, panes));
  return actor;
};

describe('a tab switch and the scrollback views on the tab left behind', () => {
  it('closes a scroll view on the tab the user left', () => {
    const panes = [pane(pid('%1'), ONE), pane(pid('%2'), TWO)];
    const actor = connected(panes);
    actor.send({ type: 'ENTER_SCROLL_MODE', paneId: pid('%1'), scrollLines: -3 });
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]?.mode).toBe('scroll');

    actor.send(showing(TWO, panes));
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]).toBeUndefined();
  });

  it('closes it as soon as a tab is picked in this client, before tmux answers', () => {
    // A tab click switches the client at once; by the time the model update
    // reports the switch, the client is already on the new tab.
    const panes = [pane(pid('%1'), ONE), pane(pid('%2'), TWO)];
    const actor = connected(panes);
    actor.send({ type: 'ENTER_SCROLL_MODE', paneId: pid('%1'), scrollLines: -3 });

    actor.send({ type: 'SELECT_TAB', windowId: TWO });
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]).toBeUndefined();
  });

  it('keeps copy mode, which the pane is really in', () => {
    const panes = [pane(pid('%1'), ONE, true), pane(pid('%2'), TWO)];
    const actor = connected([pane(pid('%1'), ONE), pane(pid('%2'), TWO)]);
    actor.send({ type: 'ENTER_COPY_MODE', paneId: pid('%1') });
    actor.send(showing(ONE, panes));
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]?.mode).toBe('copy');

    actor.send(showing(TWO, panes));
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]?.mode).toBe('copy');
  });

  it('leaves a scroll view alone while its tab stays the current one', () => {
    const panes = [pane(pid('%1'), ONE), pane(pid('%2'), TWO)];
    const actor = connected(panes);
    actor.send({ type: 'ENTER_SCROLL_MODE', paneId: pid('%1'), scrollLines: -3 });

    actor.send(showing(ONE, panes));
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]?.mode).toBe('scroll');
  });
});
