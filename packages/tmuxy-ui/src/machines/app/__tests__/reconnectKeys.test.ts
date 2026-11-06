/**
 * Keys typed while the channel is down are not dropped by the app: they go
 * on to the transport, which holds them until the stream is back (Q5). The
 * adapter did hold them, but `reconnecting` took no command, so a line typed
 * during an outage never reached it.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromCallback, SimulatedClock } from 'xstate';
import { appMachine } from '../appMachine';
import { RECONNECT_NOTICE_DELAY_MS } from '../../constants';
import { TmuxOp } from '../../../domain/commands';

describe('typing through an outage', () => {
  it('a key and an op sent while reconnecting reach the store, noticed or not', () => {
    const sent: Array<{ type: string }> = [];
    const tmuxStoreActor = fromCallback(({ receive }) => {
      receive((event) => {
        sent.push(event as { type: string });
      });
    });
    const clock = new SimulatedClock();
    const actor = createActor(appMachine.provide({ actors: { tmuxStoreActor } } as never), {
      clock,
    }).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'TMUX_RECONNECTING' });
    const before = sent.length;

    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'send-keys -t %0 -l x' });
    clock.increment(RECONNECT_NOTICE_DELAY_MS);
    expect(actor.getSnapshot().matches({ reconnecting: 'noticed' })).toBe(true);
    actor.send({ type: 'DISPATCH_OP', op: TmuxOp.CyclePane({ windowId: null }) });

    expect(sent.slice(before).map((e) => e.type)).toEqual(['STORE_DISPATCH', 'STORE_DISPATCH']);
  });
});
