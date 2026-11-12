import { describe, it, expect } from 'vitest';
import { recorder, startApp } from '../../../test/app';
import { TmuxOp } from '../../../domain/commands';
import { MAX_HELD_COMMANDS } from '../actions/connection';

const typed = (text: string) => ({
  type: 'DISPATCH_OP' as const,
  op: TmuxOp.SendText({ target: 'tmuxy', text }),
});

/** The text of each SendText the store was handed, in order. */
const sentTexts = (store: ReturnType<typeof recorder>) =>
  store.ops().flatMap((op) => (op._tag === 'SendText' ? [op.text] : []));

describe('keys typed while the page first connects', () => {
  /**
   * The page takes keys from its first frame; the session arrives a moment
   * later. What was typed meanwhile goes out once it does, in the order
   * typed, and before anything typed after.
   */
  it('are held, then sent in order, ahead of what is typed after', () => {
    const store = recorder();
    const actor = startApp({ connected: false, actors: { tmuxStoreActor: store.logic } });
    actor.send(typed('a'));
    actor.send(typed('b'));
    expect(sentTexts(store)).toEqual([]);

    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send(typed('c'));
    expect(sentTexts(store)).toEqual(['a', 'b', 'c']);
    expect(actor.getSnapshot().context.heldCommands).toEqual([]);
  });

  it('are held up to a bound, the newest kept', () => {
    const store = recorder();
    const actor = startApp({ connected: false, actors: { tmuxStoreActor: store.logic } });
    for (let i = 0; i < MAX_HELD_COMMANDS + 10; i++) actor.send(typed(String(i)));
    actor.send({ type: 'TMUX_CONNECTED' });
    const sent = sentTexts(store);
    expect(sent).toHaveLength(MAX_HELD_COMMANDS);
    expect(sent[0]).toBe('10');
    expect(sent[sent.length - 1]).toBe(String(MAX_HELD_COMMANDS + 9));
  });
});
