/**
 * The active pane is the current window's.
 *
 * tmux names no active pane while a window it has just made current has none
 * listed yet: five tabs opened at once, typing straight after, the new tabs
 * still in flight. The pane this client had was held through that from the
 * window left behind, so the keys went to a pane of a hidden tab and nothing
 * on screen showed them.
 *
 * `appMachine` is exported with stub actors, so it starts standalone.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import type { TmuxPane, TmuxWindow } from '../../../domain/client';
import type { OpId, TmuxClientModel, TmuxSnapshot } from '../../../domain/store/types';
import { makePendingOp } from '../../../domain/store/model';
import { TmuxOp } from '../../../domain/commands';
import type { PaneId, WindowId } from '../../../domain/ids';

const ONE = wid('@1');
const TWO = wid('@2');

const pane = (tmuxId: PaneId, windowId: WindowId, width = 80): TmuxPane => ({
  id: Number(tmuxId.slice(1)),
  tmuxId,
  windowId,
  content: [],
  cursorX: 0,
  cursorY: 0,
  width,
  height: 23,
  x: 0,
  y: 1,
  active: true,
  command: 'bash',
  title: '',
  borderTitle: '',
  inMode: false,
  copyCursorX: 0,
  copyCursorY: 0,
  alternateOn: false,
  mouseAnyFlag: false,
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
) => {
  const snapshot: TmuxSnapshot = {
    panes,
    windows: [tab(ONE, 0, activeWindowId === ONE), tab(TWO, 1, activeWindowId === TWO)],
    activePaneId,
    activeWindowId,
    totalWidth: 80,
    totalHeight: 24,
    sessionName: 'main',
    focusRequest: '',
    pluginsRev: '',
    themeRev: '',
  };
  const model: TmuxClientModel = {
    committed: snapshot,
    ops: inFlight ? [newTab] : [],
    derived: snapshot,
    paneKeyOverrides: {},
  };
  return { type: 'TMUX_MODEL_UPDATE' as const, model };
};

const onTabOne = () => {
  const actor = createActor(appMachine).start();
  actor.send({ type: 'TMUX_CONNECTED' });
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
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send(update(ONE, pid('%1'), [pane(pid('%1'), ONE), pane(pid('%2'), TWO)]));
    // The same panes, one of them resized.
    actor.send(update(TWO, pid('%2'), [pane(pid('%1'), ONE, 40), pane(pid('%2'), TWO)], true));
    expect(actor.getSnapshot().context.activeWindowId).toBe(TWO);
    expect(actor.getSnapshot().context.activePaneId).toBe(pid('%2'));
  });
});
