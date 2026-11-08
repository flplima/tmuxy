/**
 * The HTTP driver against a scripted EventSource and fetch: the stream's
 * lifecycle (connect, drop, reconnect, give up), what each kind of server
 * answer becomes, and, through the transport the app runs on it, the serial
 * lane every tmux op takes — a split fired right after a tab switch must not
 * reach the server first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect, ManagedRuntime, Schedule, Stream } from 'effect';
import { HttpTransportLive } from '../../layers';
import { TmuxTransport, type TmuxTransportService } from '../../TmuxTransport';
import { HttpAdapter } from '../HttpAdapter';
import { REOPEN_AFTER_DROP_MS } from '../httpStream';
import { installMockEventSource, MockEventSource, openStreams, stream } from './mockEventSource';
import type { ServerState } from '../../../../domain/wire';
import { TmuxOp } from '../../../../domain/commands';

/** Every Fatal the adapter publishes, and the first one once it comes. */
const fatalsOf = (adapter: HttpAdapter) => {
  const all: string[] = [];
  const first = new Promise<string>((resolve) => {
    adapter.events.subscribe((e) => {
      if (e._tag !== 'Fatal') return;
      all.push(e.message);
      resolve(e.message);
    });
  });
  return { all, first };
};

describe('HttpAdapter connect() lifecycle', () => {
  let restoreEventSource: () => void;

  beforeEach(() => {
    restoreEventSource = installMockEventSource();
  });

  afterEach(() => {
    restoreEventSource();
    vi.unstubAllGlobals();
  });

  it('dedupes concurrent connect() calls into a single EventSource', async () => {
    const adapter = new HttpAdapter();
    const p1 = adapter.connect();
    const p2 = adapter.connect();
    // Two callers, one stream: the supervised fiber is created synchronously by
    // the first connect(), so the second dedupes onto it instead of opening a
    // rival stream.
    const es = await stream(0);
    expect(MockEventSource.instances.length).toBe(1);

    es.emit('connection-info', { data: { connection_id: 1, default_shell: 'bash' } });
    await Promise.all([p1, p2]);

    expect(adapter.isConnected()).toBe(true);
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  });

  it('keeps retrying when a reconnect attempt fails to establish (no dead-loop)', async () => {
    // A reconnect whose EventSource failed to OPEN once ended the retry loop,
    // leaving the client disconnected until a reload: an establish failure
    // must be retried like a drop.
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const first = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await first;

    MockEventSource.instances[0].onerror?.(new Event('error'));
    // ES2 never reaches connected and errors (server still restarting).
    (await stream(1)).onerror?.(new Event('error'));

    // Server finally answers on the third stream — the client recovers on its
    // own, no reload.
    (await stream(2)).emit('connection-info', { data: { connection_id: 3 } });
    await vi.waitFor(() => expect(adapter.isConnected()).toBe(true));
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  });

  it('ten drops in a row each reconnect after the same short pause, on the real backoff schedule', async () => {
    // One schedule for the channel's whole life only ever climbed: by the
    // fifth drop a reconnect waited 16s, then 30s for good, however briefly
    // the link had been down. The default schedule, deliberately — a 1ms one
    // cannot show this.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const adapter = new HttpAdapter();
      const first = adapter.connect();
      (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
      await first;

      for (let drop = 1; drop <= 10; drop++) {
        MockEventSource.instances[drop - 1].onerror?.(new Event('error'));
        const reopened = stream(drop);
        await vi.advanceTimersByTimeAsync(REOPEN_AFTER_DROP_MS);
        (await reopened).emit('connection-info', { data: { connection_id: drop } });
        expect(adapter.isConnected()).toBe(true);
      }
      expect(openStreams().length).toBe(1);
      adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pinged stream that goes silent is dropped and reopened', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
      const first = adapter.connect();
      const es = await stream(0);
      es.emit('connection-info', { data: { connection_id: 1 } });
      await first;

      // No ping seen yet (an older server): silence proves nothing.
      vi.advanceTimersByTime(60_000);
      expect(adapter.isConnected()).toBe(true);

      es.emit('ping', 1);
      vi.advanceTimersByTime(3_000);
      expect(adapter.isConnected()).toBe(true);
      vi.advanceTimersByTime(4_000);
      expect(es.closed).toBe(true);
      expect(adapter.isConnected()).toBe(false);
      vi.useRealTimers();
      await stream(1);
      adapter.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stream the server refuses ends in its reason, not in endless retrying', async () => {
    // Behind a proxy without --allowed-host every API route is a 403, and
    // EventSource reports that as the same bare error as a server that is down.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 403,
        text: () =>
          Promise.resolve('forbidden: request Host is not this server (see --allowed-host)\n'),
      }),
    );
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const fatals = fatalsOf(adapter);
    const connecting = adapter.connect();

    (await stream(0)).onerror?.(new Event('error'));
    expect(await fatals.first).toBe(
      'The server refused this page: request Host is not this server (see --allowed-host)',
    );

    // The retry was already scheduled when the refusal came back: that
    // attempt fails too, and nothing follows it — the channel gives up, and
    // the caller still waiting on connect() hears so.
    (await stream(1)).onerror?.(new Event('error'));
    await expect(connecting).rejects.toThrow();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(fatals.all).toHaveLength(1);
    await expect(adapter.connect()).rejects.toThrow(/fatal/);
    adapter.disconnect();
  });

  it('creates a missing session via POST /commands when /events answers 404, then reconnects immediately', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
        if (url.includes('/events')) {
          return Promise.resolve({ status: 404, ok: false, text: async () => 'session not found' });
        }
        return Promise.resolve({ status: 200, ok: true, json: async () => ({ result: null }) });
      }),
    );
    // Long backoff so only reconnectNow() after ensure_session can open the second stream promptly.
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('30 seconds') });
    const connected = adapter.connect();
    (await stream(0)).onerror?.(new Event('error'));

    const second = await stream(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/commands?session=tmuxy');
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ cmd: 'ensure_session', args: {} });

    second.emit('connection-info', { data: { connection_id: 2, default_shell: 'bash' } });
    await connected;
    expect(adapter.isConnected()).toBe(true);
    adapter.disconnect();
  });

  it('a session the server will not create is shown as the reason, not retried behind "Connecting…"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/events')) {
          return Promise.resolve({ status: 404, ok: false, text: async () => 'session not found' });
        }
        return Promise.resolve({
          status: 503,
          ok: false,
          json: async () => ({ error: 'too many sessions to create another', kind: 'invalid' }),
        });
      }),
    );
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const fatals = fatalsOf(adapter);
    adapter.connect().catch(() => {});

    (await stream(0)).onerror?.(new Event('error'));
    expect(await fatals.first).toBe(
      'The server refused this session: too many sessions to create another',
    );
    adapter.disconnect();
  });
});

describe('the HTTP transport the app runs: initial state and the serial lane', () => {
  let restoreEventSource: () => void;

  beforeEach(() => {
    restoreEventSource = installMockEventSource();
  });

  afterEach(() => {
    restoreEventSource();
    vi.unstubAllGlobals();
  });

  /**
   * The web transport as the app runs it (HttpTransportLive), with the most
   * recent state it published.
   */
  const openTransport = () => {
    const runtime = ManagedRuntime.make(HttpTransportLive);
    let last: ServerState | null = null;
    runtime.runFork(
      Effect.scoped(
        Effect.flatMap(
          Effect.flatMap(TmuxTransport, (t) => t.subscribe),
          Stream.runForEach((e) =>
            Effect.sync(() => {
              if (e._tag === 'State') last = e.state;
            }),
          ),
        ),
      ),
    );
    return {
      call: <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) =>
        runtime.runPromise(Effect.flatMap(TmuxTransport, f)),
      lastState: () => last,
      close: () => runtime.dispose(),
    };
  };

  const pane = (content: Array<Array<{ c: string }>>) => ({
    id: 1,
    tmux_id: '%1',
    window_id: '@1',
    content,
    cursor_x: 0,
    cursor_y: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 0,
    active: true,
    command: 'bash',
    title: '',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
  });
  const state = (content: Array<Array<{ c: string }>>) => ({
    session_name: 's',
    active_window_id: '@1',
    active_pane_id: '%1',
    panes: [pane(content)],
    windows: [{ id: '@1', index: 1, name: 's', active: true, window_type: 'tab' }],
    total_width: 80,
    total_height: 24,
  });

  it('an initial-state answer older than the stream does not blank a pane the stream filled', async () => {
    // The E2E start-up failure: the server snapshots the session before the
    // shell's prompt is in, the stream delivers a full state WITH the prompt
    // while that answer is in flight, and the answer arriving last used to
    // overwrite it. An idle shell never prints again, so the pane stayed
    // blank for good.
    let answer: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const transport = openTransport();
    const connected = transport.call((t) => t.connect);
    const es = await stream(0);
    es.emit('connection-info', { data: { connection_id: 1 } });
    await connected;

    const initial = transport.call((t) => t.fetchState({ cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const prompt = [[{ c: '$' }, { c: ' ' }]];
    es.emit('state-update', { data: { type: 'full', state: state(prompt) } });
    answer({ ok: true, json: async () => ({ result: state([[{ c: ' ' }]]) }) });

    const result = (await initial) as ReturnType<typeof state>;
    expect(result.panes[0].content).toEqual(prompt);
    await transport.close();
  });

  /** A connected transport whose next `fetch` waits until `answer` is called. */
  const withPendingAnswer = async () => {
    let answer: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    );
    const transport = openTransport();
    const connected = transport.call((t) => t.connect);
    const es = await stream(0);
    es.emit('connection-info', { data: { connection_id: 1 } });
    await connected;
    return {
      transport,
      es,
      answer: (result: unknown) => answer({ ok: true, json: async () => ({ result }) }),
    };
  };

  const withTab = (base: ReturnType<typeof state>, id: string) => ({
    ...base,
    windows: [...base.windows, { id, index: 2, name: 's', active: false, window_type: 'tab' }],
  });

  it('an initial-state answer older than the stream does not take back a window the stream added', async () => {
    // The session-restore failure: the answer is taken while the restore is
    // still making windows, the stream delivers them, and to the server
    // nothing changes after that — no delta would ever bring them back.
    const { transport, es, answer } = await withPendingAnswer();
    const initial = transport.call((t) => t.fetchState({ cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    const prompt = [[{ c: '$' }]];
    es.emit('state-update', { data: { type: 'full', state: withTab(state(prompt), '@2') } });
    answer(state(prompt));

    const result = (await initial) as ReturnType<typeof state>;
    expect(result.windows.map((w) => w.id)).toEqual(['@1', '@2']);
    await transport.close();
  });

  it('after a gap in the stream, the answer is the state to start again from', async () => {
    const { transport, es, answer } = await withPendingAnswer();
    const prompt = [[{ c: '$' }]];
    // The client's first answer, which also gives the resync its size.
    const initial = transport.call((t) => t.fetchState({ cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer(state(prompt));
    await initial;
    es.emit('state-update', { data: { type: 'full', state: state(prompt) } });
    es.emit('state-update', { data: { type: 'delta', delta: { seq: 1 } } });
    // seq 3 after 1: a delta was lost, and the adapter asks for a full state.
    es.emit('state-update', { data: { type: 'delta', delta: { seq: 3 } } });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    answer(withTab(state(prompt), '@5'));

    await vi.waitFor(() =>
      expect(transport.lastState()?.windows.map((w) => w.id)).toEqual(['@1', '@5']),
    );
    await transport.close();
  });

  /** A connected transport over a fetch that records each POST's command and connection. */
  const connectedTransport = async (
    respond: (command: string) => Promise<unknown> = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ result: null }) }),
  ) => {
    const posted: Array<{ command: string; connectionId: string }> = [];
    const transport = openTransport();
    const connected = transport.call((t) => t.connect);
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await connected;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          (_url: string, init: { body: string; headers: Record<string, string> }) => {
            const command = JSON.parse(init.body).args.command as string;
            posted.push({ command, connectionId: init.headers['X-Connection-Id'] });
            return respond(command);
          },
        ),
    );
    return { transport, posted };
  };

  it('runs every tmux op through the serial lane in issue order', async () => {
    // Each POST resolves only when the test releases it, so the second op
    // cannot complete before the first unless the lane reordered them.
    const releases: Array<() => void> = [];
    const { transport, posted } = await connectedTransport(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true, json: () => Promise.resolve({ result: null }) }));
        }),
    );

    const r1 = transport.call((t) => t.run(TmuxOp.RawCommand({ command: 'first' })));
    const r2 = transport.call((t) => t.run(TmuxOp.RawCommand({ command: 'second' })));

    // Only the first POST has left the browser; the second waits behind it.
    await vi.waitFor(() => expect(posted.map((p) => p.command)).toEqual(['first']));
    releases[0]();
    await vi.waitFor(() => expect(posted.map((p) => p.command)).toEqual(['first', 'second']));
    releases[1]();
    await Promise.all([r1, r2]);
    await transport.close();
  });

  it('a key typed while the stream is down is posted once it is back, under the new connection, before later commands', async () => {
    const { transport, posted } = await connectedTransport();

    // The stream drops; the user keeps typing, then splits the pane.
    MockEventSource.instances[0].onerror?.(new Event('error'));
    await stream(1);
    await transport.call((t) => t.run(TmuxOp.SendText({ target: '%1', text: 'x' })));
    const split = transport.call((t) => t.run(TmuxOp.Split({ direction: 'vertical' })));

    // Nothing leaves the browser while the stream is down...
    expect(posted).toEqual([]);

    // ...and once it is back, the key goes first, naming the new connection.
    MockEventSource.instances[1].emit('connection-info', { data: { connection_id: 2 } });
    await split;
    expect(posted).toEqual([
      { command: "send-keys -t %1 -l -- 'x'", connectionId: '2' },
      { command: 'split-window -h', connectionId: '2' },
    ]);
    await transport.close();
  });
});
