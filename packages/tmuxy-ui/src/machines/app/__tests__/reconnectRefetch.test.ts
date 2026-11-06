/**
 * A stream that comes back asks for the state again.
 *
 * The bug this pins: `TMUX_RECONNECTED` fetched the themes and nothing else.
 * Against a restarted server whose monitor another tab had already synced,
 * an idle session sends nothing on its own, so the reconnected tab kept its
 * last frame until a keystroke produced a delta. The first connection fetches
 * the state at the client's viewport; a reconnection must do the same.
 *
 * `appMachine` is exported with stub actors; the tmux one is replaced by a
 * recorder so what the machine asks of it can be read back.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromCallback, type AnyActorRef } from 'xstate';
import { appMachine } from '../appMachine';
import type { TmuxActorEvent } from '../../actors/tmuxActor';

function recordingActor() {
  const asked: TmuxActorEvent[] = [];
  const tmuxActor = fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(({ receive }) => {
    receive((event) => asked.push(event));
    return () => {};
  });
  const machine = appMachine.provide({ actors: { tmuxActor } } as never);
  const actor = createActor(machine).start();
  return { actor, asked };
}

const initialStateFetches = (asked: TmuxActorEvent[]) =>
  asked.filter((e) => e.type === 'FETCH_INITIAL_STATE');

describe('a reconnected stream', () => {
  it('fetches the state at the viewport the client measured', () => {
    const { actor, asked } = recordingActor();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 30 });
    asked.length = 0;

    actor.send({ type: 'TMUX_RECONNECTING' });
    actor.send({ type: 'TMUX_RECONNECTED' });

    expect(initialStateFetches(asked)).toEqual([
      { type: 'FETCH_INITIAL_STATE', cols: 120, rows: 30 },
    ]);
  });

  it('waits for a measured viewport, as the first connection does', () => {
    const { actor, asked } = recordingActor();
    actor.send({ type: 'TMUX_CONNECTED' });
    asked.length = 0;

    actor.send({ type: 'TMUX_RECONNECTING' });
    actor.send({ type: 'TMUX_RECONNECTED' });

    expect(initialStateFetches(asked)).toEqual([]);
  });
});
