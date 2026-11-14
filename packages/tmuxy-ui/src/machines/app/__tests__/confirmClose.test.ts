/**
 * A close that would end a pane still at work is held until the user says
 * yes (`domain/closeGuard.ts`). Every way to close ends in the dispatcher,
 * so that is where it is held: a button's event, an op, a binding's string.
 */

import { describe, it, expect } from 'vitest';
import { TmuxOp } from '../../../domain/commands';
import { PaneId, WindowId } from '../../../domain/ids';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
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

  it('the close keys in a float are checked against the float, not the pane behind it', () => {
    // The binding is pinned to the pane holding the keyboard, and the parser
    // drops the pin: the op names no pane. An agent working in a float over
    // an idle shell must be asked about, and an idle float over a working
    // pane must not.
    const FLOAT = PaneId.make('%9');
    const floatOver = (floatState: string | null, behindState: string | null) => {
      const store = recorder();
      const actor = startApp({
        actors: { tmuxStoreActor: store.logic },
        context: {
          panes: [
            modelPane(AGENT, W1, { paneState: behindState, active: true }),
            modelPane(FLOAT, W2, { command: 'claude', paneState: floatState }),
          ],
          windows: [modelWindow(W1, 1, { active: true }), modelWindow(W2, 2)],
          activePaneId: AGENT,
          activeWindowId: W1,
          keyboardOwner: { kind: 'float', paneId: FLOAT },
        },
      });
      actor.send({
        type: 'SEND_TMUX_COMMAND',
        command: `select-window -t ${W1} \\; select-pane -t ${FLOAT} \\; kill-pane`,
      });
      return { pending: actor.getSnapshot().context.pendingClose, sent: store.ops().length };
    };

    const busyFloat = floatOver('working', null);
    expect(busyFloat.pending?.busy.map((p) => p.paneId)).toEqual([FLOAT]);
    expect(busyFloat.sent).toBe(0);

    const idleFloat = floatOver(null, 'working');
    expect(idleFloat.pending).toBeNull();
    expect(idleFloat.sent).toBe(1);
  });

  it("the tab close keys in a float close the float's window, and are checked against it", () => {
    const FLOAT = PaneId.make('%9');
    const store = recorder();
    const actor = startApp({
      actors: { tmuxStoreActor: store.logic },
      context: {
        panes: [modelPane(AGENT, W1, { paneState: 'working', active: true }), modelPane(FLOAT, W2)],
        windows: [modelWindow(W1, 1, { active: true }), modelWindow(W2, 2)],
        activePaneId: AGENT,
        activeWindowId: W1,
        keyboardOwner: { kind: 'float', paneId: FLOAT },
      },
    });
    actor.send({
      type: 'SEND_TMUX_COMMAND',
      command: `select-window -t ${W1} \\; select-pane -t ${FLOAT} \\; kill-window`,
    });
    expect(actor.getSnapshot().context.pendingClose).toBeNull();
    expect(store.ops()).toHaveLength(1);
  });

  it('a kill the parser does not know is held too', () => {
    for (const command of ['kill-window -a -t @2', 'respawn-pane -k', 'kill-session']) {
      const { actor, pending, closes } = app();
      actor.send({ type: 'SEND_TMUX_COMMAND', command });
      expect(closes(), command).toEqual([]);
      expect(
        pending()?.busy.map((p) => p.paneId),
        command,
      ).toEqual([AGENT]);
    }
  });

  it('the question goes when the pane it names stops being busy', () => {
    const { actor, pending } = app();
    actor.send({ type: 'CLOSE_PANE', paneId: AGENT });
    expect(pending()).not.toBeNull();
    actor.send(
      modelUpdate(
        [modelPane(AGENT, W1, { command: 'claude', active: true }), modelPane(SHELL, W1)],
        [modelWindow(W1, 1, { active: true })],
        { paneId: AGENT, windowId: W1 },
      ),
    );
    expect(pending()).toBeNull();
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
