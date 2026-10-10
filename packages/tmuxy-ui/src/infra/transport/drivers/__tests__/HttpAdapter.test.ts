/**
 * The HTTP driver against a scripted EventSource and fetch: the stream's
 * lifecycle (connect, drop, reconnect, give up), what each kind of server
 * answer becomes, and the serial queue every `run_tmux_command` goes through
 * — a split fired right after a tab switch must not reach the server first.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cause, Effect, Exit, ManagedRuntime, Option, Schedule, Stream } from 'effect';
import { HttpTransportLive } from '../../layers';
import { TmuxTransport, type TmuxTransportService } from '../../TmuxTransport';
import { makeSequencedTransport } from '../../stateFeed';
import { HttpAdapter } from '../HttpAdapter';
import type { ServerState } from '../../../../domain/wire';

/**
 * Minimal EventSource stand-in — jsdom ships none. Records every instance so a
 * test can assert how many streams were opened and whether stale ones were
 * closed (the duplicate-stream / orphan-leak bug lives exactly here).
 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onerror: ((e: unknown) => void) | null = null;
  private listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string }) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  emit(type: string, payload: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(payload) });
  }
  close(): void {
    this.closed = true;
  }
}

describe('HttpAdapter connect() lifecycle', () => {
  let originalES: unknown;

  beforeEach(() => {
    MockEventSource.instances = [];
    originalES = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = MockEventSource;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).EventSource = originalES;
    vi.unstubAllGlobals();
  });

  const openStreams = () => MockEventSource.instances.filter((e) => !e.closed);

  // The channel opens its EventSource on a microtask (the Effect fiber), so a
  // test must await the stream's existence before driving it. The fiber itself
  // is created synchronously by connect(), so dedupe still holds immediately.
  const stream = async (i: number): Promise<MockEventSource> => {
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(i));
    return MockEventSource.instances[i];
  };

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

  it('reopens one stream after a drop without orphaning, and dedupes concurrent connect()', async () => {
    // Near-zero backoff so the supervised fiber reopens promptly under vitest.
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const first = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await first;

    // Drop: onerror closes ES1, marks disconnected; the fiber schedules a reopen.
    const es1 = MockEventSource.instances[0];
    es1.onerror?.(new Event('error'));
    expect(es1.closed).toBe(true);
    expect(adapter.isConnected()).toBe(false);

    // Callers during the reconnect window don't spawn rival streams — the fiber
    // owns reopening; they just wait for the next connected transition.
    const a = adapter.connect();
    const b = adapter.connect();

    // Exactly one NEW stream opens (total 2); ES1 stays closed.
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(2));
    expect(openStreams().length).toBe(1);

    MockEventSource.instances[1].emit('connection-info', { data: { connection_id: 2 } });
    await Promise.all([a, b]);
    expect(adapter.isConnected()).toBe(true);
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  });

  it('keeps retrying when a reconnect attempt fails to establish (no dead-loop)', async () => {
    // Regression: the old imperative path scheduled a reconnect only from the
    // *connected-then-dropped* branch. When a reconnect's EventSource failed to
    // OPEN, onerror rejected and returned without rescheduling, so the loop died
    // and the client stayed disconnected until a manual reload. The Schedule
    // treats an establish failure and a drop identically, so it must retry both.
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const first = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await first;

    // Drop → fiber reopens ES2.
    MockEventSource.instances[0].onerror?.(new Event('error'));
    // ES2 never reaches connected and errors (server still restarting). The old
    // code gave up here; the Schedule must reopen ES3.
    (await stream(1)).onerror?.(new Event('error'));

    // Server finally answers on the third stream — the client recovers on its
    // own, no reload.
    (await stream(2)).emit('connection-info', { data: { connection_id: 3 } });
    await vi.waitFor(() => expect(adapter.isConnected()).toBe(true));
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  });

  it('a tmux-error event reaches onError listeners and leaves the stream open', async () => {
    // The wire name matters: a server event named `error` also fires
    // EventSource.onerror, and every reported error would bounce the connection.
    const adapter = new HttpAdapter();
    const seen: string[] = [];
    adapter.events.subscribe((e) => {
      if (e._tag === 'Error') seen.push(e.message);
    });
    const p = adapter.connect();
    const es = await stream(0);
    es.emit('connection-info', { data: { connection_id: 1 } });
    await p;

    es.emit('tmux-error', { data: { message: "can't find window: @999" } });
    expect(seen).toEqual(["can't find window: @999"]);
    expect(adapter.isConnected()).toBe(true);
    expect(es.closed).toBe(false);
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  });

  it('a fatal first event rejects connect() instead of hanging', async () => {
    const adapter = new HttpAdapter();
    const p = adapter.connect();
    (await stream(0)).emit('fatal', { data: { message: 'tmux gone' } });
    await expect(p).rejects.toThrow('tmux gone');
    // A later connect() is refused (fatal), not wedged on the cached promise.
    await expect(adapter.connect()).rejects.toThrow(/fatal/i);
  });

  it('switchSession clears a prior fatal so the new session can connect', async () => {
    const adapter = new HttpAdapter();
    const p = adapter.connect();
    (await stream(0)).emit('fatal', { data: { message: 'dead session' } });
    await expect(p).rejects.toThrow('dead session');

    // Pre-fix, switchSession left this.fatal set and connect() rejected forever,
    // so recovering by switching to a live session needed a page reload.
    const switchP = adapter.switchSession('other');
    const newEs = await stream(1);
    expect(newEs.url).toContain('session=other');
    newEs.emit('connection-info', { data: { connection_id: 5 } });
    await switchP;
    expect(adapter.isConnected()).toBe(true);
    adapter.disconnect();
  });

  it('invoke surfaces the HTTP status when an error response body is not JSON', async () => {
    const adapter = new HttpAdapter();
    const c = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await c;

    // A reverse-proxy 502 HTML page: response.json() throws. The adapter must
    // surface the HTTP status, not the JSON SyntaxError.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      }),
    );
    await expect(adapter.invoke('get_themes_list')).rejects.toThrow('HTTP 502');
    adapter.disconnect();
  });

  it("a query tmux refused rejects as a TmuxError carrying tmux's message", async () => {
    const adapter = new HttpAdapter();
    const c = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await c;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "can't find pane: %9", kind: 'tmux' }),
      }),
    );
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.flatMap(makeSequencedTransport(adapter, { latestPerFrame: false }), (t) =>
          t.query('display -p -t %9 "#{pane_id}"'),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.getOrNull(failure)).toMatchObject({
        _tag: 'TmuxError',
        command: 'display -p -t %9 "#{pane_id}"',
        stderr: "can't find pane: %9",
      });
    }
    adapter.disconnect();
  });

  it('ten drops in a row each reconnect at once, on the real backoff schedule', async () => {
    // One schedule for the channel's whole life only ever climbed: by the
    // fifth drop a reconnect waited 16s, then 30s for good, however briefly
    // the link had been down. The default schedule, deliberately — a 1ms one
    // cannot show this.
    const adapter = new HttpAdapter();
    const first = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await first;

    for (let drop = 1; drop <= 10; drop++) {
      const droppedAt = Date.now();
      MockEventSource.instances[drop - 1].onerror?.(new Event('error'));
      await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(drop + 1), {
        timeout: 1500,
      });
      expect(Date.now() - droppedAt).toBeLessThan(1500);
      MockEventSource.instances[drop].emit('connection-info', { data: { connection_id: drop } });
      await vi.waitFor(() => expect(adapter.isConnected()).toBe(true));
    }
    expect(openStreams().length).toBe(1);
    adapter.disconnect();
  }, 20000);

  it('retries at once when the browser comes back online, not at the next backoff tick', async () => {
    // A long backoff, so only the hint can explain a prompt second attempt.
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 hours') });
    const connecting = adapter.connect();
    (await stream(0)).onerror?.(new Event('error'));
    expect(MockEventSource.instances.length).toBe(1);

    window.dispatchEvent(new Event('online'));
    (await stream(1)).emit('connection-info', { data: { connection_id: 2 } });
    await connecting;
    expect(adapter.isConnected()).toBe(true);
    expect(openStreams().length).toBe(1);

    // Connected: a hint has nothing to do, and must not bounce the stream.
    window.dispatchEvent(new Event('online'));
    adapter.reconnectNow();
    expect(MockEventSource.instances.length).toBe(2);
    adapter.disconnect();
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
    const fatals: string[] = [];
    adapter.events.subscribe((e) => {
      if (e._tag === 'Fatal') fatals.push(e.message);
    });
    adapter.connect().catch(() => {});

    (await stream(0)).onerror?.(new Event('error'));
    await vi.waitFor(() => expect(fatals).toHaveLength(1));
    expect(fatals[0]).toBe(
      'The server refused this page: request Host is not this server (see --allowed-host)',
    );

    // Whatever attempt was already scheduled fails too, and nothing follows it.
    const opened = MockEventSource.instances.length;
    MockEventSource.instances[opened - 1].onerror?.(new Event('error'));
    await new Promise((r) => setTimeout(r, 50));
    expect(MockEventSource.instances.length).toBeLessThanOrEqual(opened + 1);
    expect(fatals).toHaveLength(1);
    adapter.disconnect();
  });

  it('a server that is merely unavailable keeps being retried, with no verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ status: 502, text: () => Promise.resolve('') }),
    );
    const adapter = new HttpAdapter({ reconnectSchedule: Schedule.spaced('1 millis') });
    const fatals: string[] = [];
    adapter.events.subscribe((e) => {
      if (e._tag === 'Fatal') fatals.push(e.message);
    });
    const connecting = adapter.connect();

    (await stream(0)).onerror?.(new Event('error'));
    (await stream(1)).emit('connection-info', { data: { connection_id: 7 } });
    await connecting;
    expect(adapter.isConnected()).toBe(true);
    expect(fatals).toHaveLength(0);
    adapter.disconnect();
  });

  it('a read-only server is sent reads only, and never a viewport', async () => {
    const adapter = new HttpAdapter();
    const infos: Array<boolean | undefined> = [];
    adapter.events.subscribe((e) => {
      if (e._tag === 'ConnectionInfo') infos.push(e.readOnly);
    });
    const c = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1, read_only: true } });
    await c;
    expect(infos).toEqual([true]);
    expect(adapter.readOnly).toBe(true);
    expect(adapter.enumeratesSessions).toBe(false);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            session_name: 's',
            active_window_id: null,
            active_pane_id: null,
            panes: [],
            windows: [],
            total_width: 10,
            total_height: 5,
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(adapter.invoke('run_tmux_command', { command: 'kill-server' })).rejects.toThrow();
    await expect(adapter.invoke('set_client_size', { cols: 10, rows: 5 })).rejects.toThrow();
    await expect(adapter.query('list-panes')).rejects.toThrow();
    await adapter.invoke('run_tmux_command', { command: 'send-keys -t %0 -l x' }).catch(() => {});
    expect(fetchMock).not.toHaveBeenCalled();

    await adapter.invoke('get_initial_state', { cols: 10, rows: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      cmd: 'get_initial_state',
      args: {},
    });
    adapter.disconnect();
  });

  it('runs run_tmux_command through the serial queue in issue order', async () => {
    const adapter = new HttpAdapter();
    const c = adapter.connect();
    (await stream(0)).emit('connection-info', { data: { connection_id: 1 } });
    await c;

    // Each POST resolves only when the test releases it, so the second command
    // cannot complete before the first unless the queue reordered them.
    const posted: string[] = [];
    const releases: Array<() => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: { body: string }) => {
        const command = JSON.parse(init.body).args.command as string;
        posted.push(command);
        return new Promise((resolve) => {
          releases.push(() =>
            resolve({ ok: true, json: () => Promise.resolve({ result: command }) }),
          );
        });
      }),
    );

    const r1 = adapter.invoke<string>('run_tmux_command', { command: 'first' });
    const r2 = adapter.invoke<string>('run_tmux_command', { command: 'second' });

    // Only the first POST has left the browser; the second waits behind it.
    await vi.waitFor(() => expect(posted).toEqual(['first']));
    releases[0]();
    await vi.waitFor(() => expect(posted).toEqual(['first', 'second']));
    releases[1]();

    expect(await r1).toBe('first');
    expect(await r2).toBe('second');
    adapter.disconnect();
  });
});

describe('the HTTP transport: initial state against the live stream', () => {
  let originalES: unknown;

  beforeEach(() => {
    MockEventSource.instances = [];
    originalES = (globalThis as Record<string, unknown>).EventSource;
    (globalThis as Record<string, unknown>).EventSource = MockEventSource;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).EventSource = originalES;
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
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const es = MockEventSource.instances[0];
    es.emit('connection-info', { data: { connection_id: 1 } });
    await connected;

    const initial = transport.call((t) => t.invoke('get_initial_state', { cols: 80, rows: 24 }));
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
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const es = MockEventSource.instances[0];
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
    const initial = transport.call((t) => t.invoke('get_initial_state', { cols: 80, rows: 24 }));
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
    const initial = transport.call((t) => t.invoke('get_initial_state', { cols: 80, rows: 24 }));
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

  it('a state update that does not decode is a gap: the adapter refetches a full state', async () => {
    const { transport, es, answer } = await withPendingAnswer();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prompt = [[{ c: '$' }]];
    const initial = transport.call((t) => t.invoke('get_initial_state', { cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer(state(prompt));
    await initial;
    es.emit('state-update', { data: { type: 'full', state: state(prompt) } });
    // A pane id in the wrong form: nothing past the boundary may see it.
    es.emit('state-update', {
      data: { type: 'delta', delta: { seq: 1, active_pane_id: 'not-a-pane' } },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('state-update'), expect.anything());
    answer(withTab(state(prompt), '@7'));

    await vi.waitFor(() =>
      expect(transport.lastState()?.windows.map((w) => w.id)).toEqual(['@1', '@7']),
    );
    expect(transport.lastState()?.active_pane_id).not.toBe('not-a-pane');
    errors.mockRestore();
    await transport.close();
  });
});
