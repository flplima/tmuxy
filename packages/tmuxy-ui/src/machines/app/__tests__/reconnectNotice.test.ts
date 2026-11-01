/**
 * A dropped channel is quiet first: for RECONNECT_NOTICE_DELAY_MS the machine
 * sits in `reconnecting.quiet`, where nothing is drawn, so a drop that heals
 * at once — a Wi-Fi roam, a sleep/wake — is never seen. Past the delay it is
 * `reconnecting.noticed`, which the snackbar's ReconnectNotice renders.
 * The channel coming back ends either, with no notice left behind.
 *
 * `appMachine` is exported with stub actors, so it starts standalone — no
 * adapter, no tmux; the clock is simulated so the delay is exact.
 */

import { describe, it, expect } from 'vitest';
import { createActor, SimulatedClock } from 'xstate';
import { appMachine } from '../appMachine';
import { RECONNECT_NOTICE_DELAY_MS } from '../../constants';

function droppedActor() {
  const clock = new SimulatedClock();
  const actor = createActor(appMachine, { clock }).start();
  actor.send({ type: 'TMUX_CONNECTED' });
  actor.send({ type: 'TMUX_RECONNECTING' });
  return { actor, clock };
}

describe('reconnecting: quiet, then noticed', () => {
  it('is quiet for the whole delay', () => {
    const { actor, clock } = droppedActor();
    expect(actor.getSnapshot().matches({ reconnecting: 'quiet' })).toBe(true);
    clock.increment(RECONNECT_NOTICE_DELAY_MS - 1);
    expect(actor.getSnapshot().matches({ reconnecting: 'quiet' })).toBe(true);
  });

  it('is noticed once the delay has passed', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    expect(actor.getSnapshot().matches({ reconnecting: 'noticed' })).toBe(true);
  });

  it('a failed retry inside the delay does not restart it', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS / 2);
    actor.send({ type: 'TMUX_RECONNECTING' });
    clock.increment(RECONNECT_NOTICE_DELAY_MS / 2);
    expect(actor.getSnapshot().matches({ reconnecting: 'noticed' })).toBe(true);
  });

  it('a failed retry while noticed keeps the notice', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    actor.send({ type: 'TMUX_RECONNECTING' });
    expect(actor.getSnapshot().matches({ reconnecting: 'noticed' })).toBe(true);
  });

  it('a drop that heals inside the delay is never noticed', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS / 2);
    actor.send({ type: 'TMUX_RECONNECTED' });
    expect(actor.getSnapshot().value).toBe('idle');
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    expect(actor.getSnapshot().value).toBe('idle');
  });

  it('the channel coming back ends a noticed drop', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    actor.send({ type: 'TMUX_RECONNECTED' });
    expect(actor.getSnapshot().value).toBe('idle');
  });

  it('a second drop starts its own quiet window', () => {
    const { actor, clock } = droppedActor();
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    actor.send({ type: 'TMUX_RECONNECTED' });
    actor.send({ type: 'TMUX_RECONNECTING' });
    expect(actor.getSnapshot().matches({ reconnecting: 'quiet' })).toBe(true);
  });
});
