/**
 * Typed keys travel as ops from the app machine through the store to the
 * transport's lane, which batches them (Q2, Q3). The store once turned every
 * op into the string it logs, and the lane batches no strings: each key went
 * alone, and on HTTP waited out the previous key's round trip.
 */

import { describe, it, expect, vi } from 'vitest';
import { createTmuxStoreActor } from '../../actors/tmuxStoreActor';
import { makeTmuxStore } from '../../../infra/store/TmuxStore';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { fakeTransport } from '../../../test/transport';
import { startApp } from '../../../test/app';

function connectedApp() {
  const transport = fakeTransport();
  const tmuxStoreActor = createTmuxStoreActor(makeTmuxStore(), transport.runtime);
  const actor = startApp({ actors: { tmuxStoreActor } });
  const sent = () =>
    transport.invocations.map((c) => `${c.cmd} ${(c.args as { command?: string }).command}`);
  return { actor, sent };
}

describe('keystrokes from the app machine', () => {
  it('are batched on the lane, and an op sent after them waits for the batch', async () => {
    const { actor, sent } = connectedApp();
    for (const text of ['a', 'b', 'c']) {
      actor.send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: '%1', text }) });
    }
    const split = TmuxOp.Split({ direction: 'vertical' });
    actor.send({ type: 'DISPATCH_OP', op: split });

    await vi.waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()).toEqual([
      "run_tmux_command send-keys -t %1 -l -- 'a'",
      "run_tmux_command send-keys -t %1 -l -- 'bc'",
      `run_tmux_command ${toTmuxCommand(split)}`,
    ]);
  });

  it('a binding parsed into a keystroke is sent as its own string', async () => {
    const { actor, sent } = connectedApp();
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'send-keys -t %1 -l x' });

    await vi.waitFor(() => expect(sent()).toEqual(['run_tmux_command send-keys -t %1 -l x']));
  });
});
