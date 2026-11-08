/**
 * The backend reporting the connection gone for good (`TMUX_FATAL`) is
 * terminal from every live state.
 *
 * One root-level handler covers all three.
 *
 * `appMachine` is exported with stub actors, so it starts standalone — no
 * adapter, no tmux.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';

const expectDisconnected = (actor: ReturnType<typeof createActor<typeof appMachine>>) => {
  const snapshot = actor.getSnapshot();
  expect(snapshot.value).toBe('disconnected');
  expect(snapshot.context.connected).toBe(false);
  // The dead layout underneath must not animate.
  expect(snapshot.context.enableAnimations).toBe(false);
};

describe('TMUX_FATAL', () => {
  it('ends a connection that never completed', () => {
    const actor = createActor(appMachine).start();
    expect(actor.getSnapshot().value).toBe('connecting');
    actor.send({ type: 'TMUX_FATAL', message: 'gone' });
    expectDisconnected(actor);
  });

  it('ends a live connection', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.send({ type: 'TMUX_FATAL', message: 'gone' });
    expectDisconnected(actor);
  });

  it('ends a reconnection the backend gave up on', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'TMUX_RECONNECTING' });
    expect(actor.getSnapshot().matches('reconnecting')).toBe(true);
    actor.send({ type: 'TMUX_FATAL', message: 'gone' });
    expectDisconnected(actor);
  });
});
