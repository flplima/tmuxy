/**
 * The viewport keeps following the window across a session switch, and a
 * connection fetches its first state exactly once.
 *
 * A switch leaves the transport up — only the session behind it changes — so
 * the machine stays `idle` and `connected`; nothing after the switch would set
 * `connected` back, so a flag dropped there would gate every later resize off
 * until a real reconnect. The initial fetch belongs to the size actor's answer
 * to CONNECTED (the target size, sent again), never to the connect itself.
 *
 * `appMachine` is exported with stub actors, so it starts standalone with a
 * recording stand-in for the tmux actor.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromCallback, type AnyActorRef } from 'xstate';
import { appMachine } from '../appMachine';
import { pid, wid } from '../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../test/model';
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

/** The app machine with a tmux actor that records what it is sent. */
function startApp() {
  const sent: TmuxActorEvent[] = [];
  const tmuxActor = fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(({ receive }) => {
    receive((event) => sent.push(event));
    return () => {};
  });
  const actor = createActor(appMachine.provide({ actors: { tmuxActor } })).start();
  return { actor, sent };
}

const sizeRequests = (sent: TmuxActorEvent[]) =>
  sent
    .filter((e) => e.type === 'SET_CLIENT_SIZE')
    .map((e) => (e.type === 'SET_CLIENT_SIZE' ? { cols: e.cols, rows: e.rows } : undefined));

const initialFetches = (sent: TmuxActorEvent[]) =>
  sent.filter((e) => e.type === 'FETCH_INITIAL_STATE');

describe('SWITCH_SESSION', () => {
  it('a window resize after the switch still resizes the new session', () => {
    const { actor, sent } = startApp();
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

describe('TMUX_CONNECTED', () => {
  it('fetches the initial state once, at the default 80×24', () => {
    const { actor, sent } = startApp();
    actor.send({ type: 'TMUX_CONNECTED' });
    // The size actor's answer to CONNECTED: the target size, sent again.
    actor.send({ type: 'SET_TARGET_SIZE', cols: 80, rows: 24 });

    expect(initialFetches(sent)).toEqual([{ type: 'FETCH_INITIAL_STATE', cols: 80, rows: 24 }]);
    actor.stop();
  });

  it('fetches the initial state once, at a size measured before the connect', () => {
    const { actor, sent } = startApp();
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 40 });
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 40 });

    expect(initialFetches(sent)).toEqual([{ type: 'FETCH_INITIAL_STATE', cols: 120, rows: 40 }]);
    actor.stop();
  });
});
