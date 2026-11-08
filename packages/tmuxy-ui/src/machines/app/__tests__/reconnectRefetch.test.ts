/**
 * A stream that comes back asks for the state again.
 *
 * The bug this pins: `TMUX_RECONNECTED` fetched the themes and nothing else.
 * Against a restarted server whose monitor another tab had already synced,
 * an idle session sends nothing on its own, so the reconnected tab kept its
 * last frame until a keystroke produced a delta. The first connection fetches
 * the state at the client's viewport; a reconnection must do the same.
 */

import { describe, it, expect } from 'vitest';
import { recorder, startApp } from '../../../test/app';

function recordingApp() {
  const tmux = recorder();
  const actor = startApp({ actors: { tmuxActor: tmux.logic } });
  return { actor, asked: tmux.received };
}

const initialStateFetches = (asked: Array<{ type: string }>) =>
  asked.filter((e) => e.type === 'FETCH_INITIAL_STATE');

describe('a reconnected stream', () => {
  it('fetches the state at the viewport the client measured', () => {
    const { actor, asked } = recordingApp();
    actor.send({ type: 'SET_TARGET_SIZE', cols: 120, rows: 30 });
    asked.length = 0;

    actor.send({ type: 'TMUX_RECONNECTING' });
    actor.send({ type: 'TMUX_RECONNECTED' });

    expect(initialStateFetches(asked)).toEqual([
      { type: 'FETCH_INITIAL_STATE', cols: 120, rows: 30 },
    ]);
  });

  it('waits for a measured viewport, as the first connection does', () => {
    const { actor, asked } = recordingApp();
    asked.length = 0;

    actor.send({ type: 'TMUX_RECONNECTING' });
    actor.send({ type: 'TMUX_RECONNECTED' });

    expect(initialStateFetches(asked)).toEqual([]);
  });
});
