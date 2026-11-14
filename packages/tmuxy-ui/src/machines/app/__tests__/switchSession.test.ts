/**
 * The viewport keeps following the window across a session switch, and a
 * connection fetches its first state exactly once.
 *
 * A switch leaves the transport up — only the session behind it changes — so
 * the machine stays `idle` and `connected`; nothing after the switch would set
 * `connected` back, so a flag dropped there would gate every later resize off
 * until a real reconnect. The initial fetch belongs to the size actor's answer
 * to RESEND_SIZE (the target size, sent again), never to the connect itself.
 */

import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
import { recorder, startApp } from '../../../test/app';
import type { TmuxActorEvent } from '../../actors/tmuxActor';

const TAB = wid('@0');
const PANE = pid('%0');

/** A session's state: one pane filling a `cols`×`rows` grid. */
const oneTab = (cols: number, rows: number) =>
  modelUpdate(
    [modelPane(PANE, TAB, { width: cols, height: rows, active: true })],
    [modelWindow(TAB, 0, { active: true })],
    { paneId: PANE, windowId: TAB },
  );

/** The app machine, not yet connected, with a tmux actor that records what it is sent. */
function recordingApp() {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic }, connected: false });
  return { actor, sent: tmux.received as TmuxActorEvent[] };
}

const sizeRequests = (sent: TmuxActorEvent[]) =>
  sent
    .filter((e) => e.type === 'SET_CLIENT_SIZE')
    .map((e) => (e.type === 'SET_CLIENT_SIZE' ? { cols: e.cols, rows: e.rows } : undefined));

const initialFetches = (sent: TmuxActorEvent[]) =>
  sent.filter((e) => e.type === 'FETCH_INITIAL_STATE');

describe('SWITCH_SESSION', () => {
  it('a window resize after the switch still resizes the new session', () => {
    const { actor, sent } = recordingApp();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send(oneTab(80, 24));
    actor.send({ type: 'SET_TARGET_SIZE', cols: 80, rows: 24 });

    actor.send({ type: 'SWITCH_SESSION', sessionName: 'other' });
    // The new session's first state lands at the old size...
    actor.send(oneTab(80, 24));
    sent.length = 0;

    // ...and then the user resizes the window.
    actor.send({ type: 'SET_TARGET_SIZE', cols: 100, rows: 30 });

    expect(actor.getSnapshot().context.connected).toBe(true);
    expect(sizeRequests(sent)).toEqual([{ cols: 100, rows: 30 }]);
    actor.stop();
  });
});

describe('TMUX_SESSION_SWITCHED', () => {
  // A session left less than the monitor's grace period ago still has its
  // monitor, which broadcasts nothing when the client comes back: the panes
  // cleared for the switch stayed cleared until something in tmux changed.
  it('asks the session switched to for its state, at the viewport', () => {
    const { actor, sent } = recordingApp();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 100, rows: 30 });
    actor.send(oneTab(100, 30));

    actor.send({ type: 'SWITCH_SESSION', sessionName: 'other' });
    expect(actor.getSnapshot().context.panes).toEqual([]);
    sent.length = 0;

    actor.send({ type: 'TMUX_SESSION_SWITCHED' });
    expect(initialFetches(sent)).toEqual([{ type: 'FETCH_INITIAL_STATE', cols: 100, rows: 30 }]);
    actor.stop();
  });
});

describe('TMUX_CONNECTED', () => {
  it('fetches the initial state once, at the default 80×24', () => {
    const { actor, sent } = recordingApp();
    actor.send({ type: 'TMUX_CONNECTED' });
    // The size actor's answer to RESEND_SIZE: the target size, sent again.
    actor.send({ type: 'SET_TARGET_SIZE', cols: 80, rows: 24 });

    expect(initialFetches(sent)).toEqual([{ type: 'FETCH_INITIAL_STATE', cols: 80, rows: 24 }]);
    actor.stop();
  });

  it('fetches the initial state once, at a size measured before the connect', () => {
    const { actor, sent } = recordingApp();
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 40 });
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 40 });

    expect(initialFetches(sent)).toEqual([{ type: 'FETCH_INITIAL_STATE', cols: 120, rows: 40 }]);
    actor.stop();
  });
});
