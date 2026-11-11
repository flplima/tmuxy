/**
 * A close that would end a pane still at work is held until the user says
 * yes (`domain/closeGuard.ts`). Every way to close ends in the dispatcher,
 * so that is where it is held: a button's event, an op, a binding's string.
 */

import { describe, it, expect } from 'vitest';
import { TmuxOp } from '../../../domain/commands';
import { PaneId, WindowId } from '../../../domain/ids';
import { modelPane, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';

const W1 = WindowId.make('@1');
const W2 = WindowId.make('@2');
const AGENT = PaneId.make('%1');
const SHELL = PaneId.make('%2');
const OTHER = PaneId.make('%3');

function app(context: { confirmClose?: boolean } = {}) {
  const store = recorder();
  const actor = startApp({
    actors: { tmuxStoreActor: store.logic },
    context: {
      panes: [
        modelPane(AGENT, W1, { command: 'claude', paneState: 'working', active: true }),
        modelPane(SHELL, W1),
        modelPane(OTHER, W2),
      ],
      windows: [modelWindow(W1, 1, { active: true }), modelWindow(W2, 2)],
      activePaneId: AGENT,
      activeWindowId: W1,
      ...context,
    },
  });
  const pending = () => actor.getSnapshot().context.pendingClose;
  return { actor, pending, closes: () => store.ops().map((op) => op._tag) };
}

describe('closing a pane that is working', () => {
  it('is held for an answer: Cancel keeps the pane, the confirmation closes it', () => {
    const { actor, pending, closes } = app();
    actor.send({ type: 'CLOSE_PANE', paneId: AGENT });
    expect(closes()).toEqual([]);
    expect(pending()).toMatchObject({
      scope: 'pane',
      busy: [{ paneId: AGENT, command: 'claude', state: 'working' }],
    });

    actor.send({ type: 'CANCEL_CLOSE' });
    expect(pending()).toBeNull();
    expect(closes()).toEqual([]);

    actor.send({ type: 'CLOSE_PANE', paneId: AGENT });
    actor.send({ type: 'CONFIRM_CLOSE' });
    expect(pending()).toBeNull();
    expect(closes()).toEqual(['KillPane']);
  });

  it('is held whichever way the close arrives: a binding, a tab close, the tab menu', () => {
    for (const close of [
      { type: 'SEND_TMUX_COMMAND', command: 'kill-pane' },
      { type: 'CLOSE_TAB', windowId: W1 },
      { type: 'DISPATCH_OP', op: TmuxOp.KillWindow({ windowId: null }) },
    ] as const) {
      const { actor, pending, closes } = app();
      actor.send(close);
      expect(closes(), close.type).toEqual([]);
      expect(pending()?.busy.map((p) => p.paneId)).toEqual([AGENT]);
      actor.send({ type: 'CONFIRM_CLOSE' });
      expect(closes(), close.type).toHaveLength(1);
    }
  });

  it('a confirmed binding goes out as the string it was bound to', () => {
    const store = recorder();
    const actor = startApp({
      actors: { tmuxStoreActor: store.logic },
      context: {
        panes: [modelPane(AGENT, W1, { paneState: 'needs-input', active: true })],
        windows: [modelWindow(W1, 1, { active: true })],
        activePaneId: AGENT,
        activeWindowId: W1,
      },
    });
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane -t %1' });
    actor.send({ type: 'CONFIRM_CLOSE' });
    expect(store.received.filter((e) => e.op).map((e) => e.wire)).toEqual(['kill-pane -t %1']);
  });

  it('an idle pane, and a tab with no busy pane, close at once', () => {
    const { actor, pending, closes } = app();
    actor.send({ type: 'CLOSE_PANE', paneId: SHELL });
    actor.send({ type: 'CLOSE_TAB', windowId: W2 });
    expect(pending()).toBeNull();
    expect(closes()).toEqual(['KillPane', 'KillWindow']);
  });

  it('with @tmuxy-confirm-close off nothing is held', () => {
    const { actor, pending, closes } = app({ confirmClose: false });
    actor.send({ type: 'CLOSE_PANE', paneId: AGENT });
    expect(pending()).toBeNull();
    expect(closes()).toEqual(['KillPane']);
  });
});
