import { afterEach, describe, it, expect, vi } from 'vitest';
import { recorder, startApp } from '../../../test/app';
import { TmuxOp } from '../../../domain/commands';
import { HELD_MAX_AGE_MS, MAX_HELD_COMMANDS } from '../actions/connection';

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

  it('are all dropped once more than the bound were typed: a tail is never sent', () => {
    const store = recorder();
    const actor = startApp({ connected: false, actors: { tmuxStoreActor: store.logic } });
    for (let i = 0; i < MAX_HELD_COMMANDS + 10; i++) actor.send(typed(String(i)));
    actor.send({ type: 'TMUX_CONNECTED' });
    expect(sentTexts(store)).toEqual([]);
    expect(notices(actor)).toEqual([
      `${MAX_HELD_COMMANDS + 10} keys typed while connecting took too long to send and were dropped`,
    ]);
  });

  /**
   * The first connection failed: keys typed before it are never sent when
   * a later one succeeds, maybe much later; an Enter among them would run a
   * command the user has given up on.
   */
  it.each([
    ['fatal', { type: 'TMUX_FATAL' as const, error: 'gone' }],
    ['reconnecting', { type: 'TMUX_RECONNECTING' as const }],
  ])('are dropped, not replayed, when the first connect fails (%s)', (_, failure) => {
    const store = recorder();
    const actor = startApp({ connected: false, actors: { tmuxStoreActor: store.logic } });
    actor.send(typed('rm'));
    actor.send(failure as never);
    actor.send({ type: 'TMUX_CONNECTED' });
    actor.send({ type: 'TMUX_RECONNECTED' } as never);
    expect(sentTexts(store)).toEqual([]);
    expect(notices(actor)).toContain('1 key typed before the connection failed was not sent');
  });

  /**
   * A line typed slowly, across the age limit, then Enter: sending only its
   * recent keys would run its tail as a command (`echo 'x: rm -rf build'`
   * → `rm -rf build'`). All of it waits or none of it goes.
   */
  it('typed slowly across the limit, are all dropped: nothing partial arrives', () => {
    vi.useFakeTimers();
    const store = recorder();
    const actor = startApp({ connected: false, actors: { tmuxStoreActor: store.logic } });
    for (const key of "echo 'x: rm -rf build'") {
      actor.send(typed(key));
      vi.advanceTimersByTime(HELD_MAX_AGE_MS / 10);
    }
    actor.send({
      type: 'DISPATCH_OP',
      op: TmuxOp.SendKeys({ target: 'tmuxy', keys: 'Enter' }),
    });
    actor.send({ type: 'TMUX_CONNECTED' });
    expect(store.ops()).toEqual([]);
    expect(notices(actor)).toEqual([
      '23 keys typed while connecting took too long to send and were dropped',
    ]);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const notices = (actor: ReturnType<typeof startApp>) =>
  actor.getSnapshot().context.notifications.map((n) => n.text);
