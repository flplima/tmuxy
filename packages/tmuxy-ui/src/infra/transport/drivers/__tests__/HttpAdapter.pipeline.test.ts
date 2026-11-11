import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect, Layer, ManagedRuntime, Schedule } from 'effect';
import { TmuxOp } from '../../../../domain/commands';
import { makeSequencedTransport } from '../../stateFeed';
import { TmuxTransport, type TmuxTransportService } from '../../TmuxTransport';
import { HttpAdapter } from '../HttpAdapter';
import { installMockEventSource, stream } from './mockEventSource';

/** One round trip of the link the typing tests run over, in ms. */
const RTT = 170;

interface Post {
  /** Fake-clock time the POST left the client. */
  at: number;
  connection: string;
  seq: string | undefined;
  command: string;
}

/** A `fetch` that records each POST and answers it one round trip later. */
function slowLink(): Post[] {
  const posts: Post[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { headers: Record<string, string>; body: string }) => {
      const { cmd, args } = JSON.parse(init.body) as { cmd: string; args: { command?: string } };
      posts.push({
        at: Date.now(),
        connection: init.headers['X-Connection-Id'],
        seq: init.headers['X-Command-Seq'],
        command: args.command ?? cmd,
      });
      return new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, json: async () => ({ result: null }) }), RTT);
      });
    }),
  );
  return posts;
}

describe('HttpAdapter pipelines the command lane', () => {
  let restoreEventSource: () => void;
  let adapter: HttpAdapter;
  let call: <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) => Promise<A>;

  const typeKey = (text: string) => call((t) => t.run(TmuxOp.SendText({ target: '%1', text })));

  beforeEach(async () => {
    restoreEventSource = installMockEventSource();
    adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const runtime = ManagedRuntime.make(
      Layer.scoped(TmuxTransport, makeSequencedTransport(adapter, { latestPerFrame: false })),
    );
    call = (f) => runtime.runPromise(Effect.flatMap(TmuxTransport, f));
    const connected = call((t) => t.connect);
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await connected;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    adapter.disconnect();
    restoreEventSource();
    vi.unstubAllGlobals();
  });

  it('typing faster than the link answers: every key leaves when it is typed, numbered in order', async () => {
    // 30 keys 60 ms apart over a 170 ms round trip: the burst that fell
    // seconds behind while each POST waited for the answer to the one before
    // (six a second, however fast the typing). Each must leave within the
    // key batcher's frame of being typed, with up to three unanswered.
    const posts = slowLink();
    const typedAt: number[] = [];
    const keys = 'abcdefghijklmnopqrstuvwxyz0123';
    for (const key of keys) {
      typedAt.push(Date.now());
      await typeKey(key);
      await vi.advanceTimersByTimeAsync(60);
    }
    await vi.advanceTimersByTimeAsync(RTT);

    expect(posts.map((p) => p.command)).toEqual(
      [...keys].map((key) => `send-keys -t %1 -l -- '${key}'`),
    );
    expect(posts.map((p) => p.seq)).toEqual(keys.split('').map((_, i) => String(i + 1)));
    const lateness = posts.map((post, i) => post.at - typedAt[i]);
    expect(Math.max(...lateness)).toBeLessThanOrEqual(16);
  });

  it('a call that follows keystrokes is numbered after them; a read carries no number', async () => {
    const posts = slowLink();
    void typeKey('a');
    void typeKey('b');
    void call((t) => t.run(TmuxOp.Split({ direction: 'vertical' })));
    void call((t) => t.query('list-panes')).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(posts.map((p) => [p.seq, p.command.split(' ')[0]])).toEqual(
      expect.arrayContaining([
        ['1', 'send-keys'],
        ['2', 'send-keys'],
        ['3', 'split-window'],
        [undefined, 'list-panes'],
      ]),
    );
    const numbered = posts.filter((p) => p.seq !== undefined).map((p) => p.seq);
    expect(numbered).toEqual(['1', '2', '3']);
    await vi.advanceTimersByTimeAsync(RTT);
  });

  it('a new connection counts from 1 again, and keys typed while it was down keep their order', async () => {
    const posts = slowLink();
    await typeKey('a');
    await vi.advanceTimersByTimeAsync(RTT);

    (await stream(0)).onerror?.(new Event('error'));
    // Typed into a dead stream, a frame apart so each is its own send.
    await typeKey('b');
    await vi.advanceTimersByTimeAsync(20);
    await typeKey('c');
    await vi.advanceTimersByTimeAsync(1000);
    expect(posts).toHaveLength(1);

    (await stream(1)).emit('connection-info', { data: { connection_id: 2 } });
    await vi.advanceTimersByTimeAsync(RTT);
    expect(posts.map((p) => [p.connection, p.seq, p.command.slice(-3)])).toEqual([
      ['1', '1', "'a'"],
      ['2', '1', "'b'"],
      ['2', '2', "'c'"],
    ]);
  });
});
