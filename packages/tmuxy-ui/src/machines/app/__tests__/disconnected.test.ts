/**
 * The backend reporting the connection gone (`TMUX_DISCONNECTED`) is terminal
 * from every live state, the way `TMUX_FATAL` is.
 *
 * The bug this pins: `idle` and `reconnecting` each handled it, `connecting`
 * did not — so a disconnect that arrived before the first `TMUX_CONNECTED`
 * was dropped, and the spinner stayed up over a connection that was never
 * going to come. One root-level handler covers all three.
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

describe('TMUX_DISCONNECTED', () => {
  it('ends a connection that never completed', () => {
    const actor = createActor(appMachine).start();
    expect(actor.getSnapshot().value).toBe('connecting');
    actor.send({ type: 'TMUX_DISCONNECTED' });
    expectDisconnected(actor);
  });

  it('ends a live connection', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    expect(actor.getSnapshot().value).toBe('idle');
    actor.send({ type: 'TMUX_DISCONNECTED' });
    expectDisconnected(actor);
  });

  it('ends a reconnection the backend gave up on', () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'TMUX_RECONNECTING' });
    expect(actor.getSnapshot().value).toBe('reconnecting');
    actor.send({ type: 'TMUX_DISCONNECTED' });
    expectDisconnected(actor);
  });
});
