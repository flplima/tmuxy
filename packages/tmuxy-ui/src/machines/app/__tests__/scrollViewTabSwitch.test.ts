/**
 * Leaving a tab closes the scroll views on it.
 *
 * A scroll view is the client's own: tmux knows nothing of it, and it hides
 * the pane's live screen behind old history. Left open on a tab the user
 * switched away from, it held that pane on what they had scrolled to while its
 * program kept printing, and the tab came back to it. Copy mode is tmux's, so
 * it stays.
 *
 * `appMachine` is exported with stub actors, so it starts standalone.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import type { TmuxPane, TmuxWindow } from '../../../domain/client';
import type { TmuxClientModel, TmuxSnapshot } from '../../../domain/store/types';
import type { PaneId, WindowId } from '../../../domain/ids';

const ONE = wid('@1');
const TWO = wid('@2');

const pane = (tmuxId: PaneId, windowId: WindowId, inMode = false): TmuxPane => ({
  id: Number(tmuxId.slice(1)),
  tmuxId,
  windowId,
  content: [],
  cursorX: 0,
  cursorY: 0,
  width: 80,
  height: 23,
  x: 0,
  y: 1,
  active: true,
  command: 'bash',
  title: '',
  borderTitle: '',
  inMode,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
  paused: false,
  historySize: 500,
  selectionPresent: false,
  selectionStartX: 0,
  selectionStartY: 0,
  cursorShape: 0,
  cursorHidden: false,
});

const tab = (id: WindowId, index: number, active: boolean): TmuxWindow => ({
  id,
  index,
  name: `tab${index}`,
  active,
  windowType: 'tab',
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
});

/** A model update with `activeWindowId` the current tab, nothing optimistic in flight. */
const showing = (activeWindowId: WindowId, panes: TmuxPane[]) => {
  const snapshot: TmuxSnapshot = {
    panes,
    windows: [tab(ONE, 0, activeWindowId === ONE), tab(TWO, 1, activeWindowId === TWO)],
    activePaneId: activeWindowId === ONE ? pid('%1') : pid('%2'),
    activeWindowId,
    totalWidth: 80,
    totalHeight: 24,
    sessionName: 'main',
    focusRequest: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: [],
    derived: snapshot,
    paneKeyOverrides: {},
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};

const connected = (panes: TmuxPane[]) => {
  const actor = createActor(appMachine).start();
  actor.send({ type: 'TMUX_CONNECTED' });
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
