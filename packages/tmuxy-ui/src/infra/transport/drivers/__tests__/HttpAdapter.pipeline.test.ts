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
  lost: string | undefined;
  command: string;
}

/**
 * A `fetch` that records each POST and answers it one round trip later. A
 * command whose text is in `dropped` gets no answer: its fetch rejects, as a
 * reset connection's does.
 */
function slowLink(dropped: string[] = []): Post[] {
  const posts: Post[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { headers: Record<string, string>; body: string }) => {
      const { cmd, args } = JSON.parse(init.body) as { cmd: string; args: { command?: string } };
      posts.push({
        at: Date.now(),
        connection: init.headers['X-Connection-Id'],
        seq: init.headers['X-Command-Seq'],
        lost: init.headers['X-Command-Lost'],
        command: args.command ?? cmd,
      });
      const fails = dropped.some((text) => (args.command ?? '').endsWith(`'${text}'`));
      return new Promise((resolve, reject) => {
        setTimeout(
          () =>
            fails
              ? reject(new TypeError('Failed to fetch'))
              : resolve({ ok: true, json: async () => ({ result: null }) }),
          RTT,
        );
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

  it('a POST that fails with no answer has its number named on the next ones, until one is answered', async () => {
    // The server holds number 3 for number 2 unless it is told 2 is not
    // coming: 5 s of dead keyboard after one reset connection.
    const posts = slowLink(['b']);
    const typed = ['a', 'b'].map((key) => typeKey(key).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(RTT + 20);
    await Promise.all(typed);

    void typeKey('c');
    await vi.advanceTimersByTimeAsync(20);
    void typeKey('d');
    await vi.advanceTimersByTimeAsync(RTT + 20);
    void typeKey('e');
    await vi.advanceTimersByTimeAsync(RTT);

    expect(posts.map((p) => [p.command.slice(-3), p.seq, p.lost])).toEqual([
      ["'a'", '1', undefined],
      ["'b'", '2', undefined],
      ['ost', undefined, '2'],
      // Left before the notice was answered: the server may not have heard yet.
      ["'c'", '3', '2'],
      ["'d'", '4', '2'],
      ["'e'", '5', undefined],
    ]);
  });

  it('a POST that fails while later ones are in flight is reported at once, with no key typed after', async () => {
    // 'b' and 'c' are at the server behind the lost 'a'. The user has
    // stopped typing, so no later command will name number 1: without a
    // notice of its own they sit there for the server's 5 s timeout.
    const posts = slowLink(['a']);
    const start = Date.now();
    const typed = ['a', 'b', 'c'].map((key) => typeKey(key).catch(() => undefined));
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(RTT);
    await Promise.all(typed);

    const notice = posts[posts.length - 1];
    expect([notice?.command, notice?.seq, notice?.lost]).toEqual(['commands_lost', undefined, '1']);
    expect((notice?.at ?? Infinity) - start).toBeLessThanOrEqual(RTT + 40);
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
