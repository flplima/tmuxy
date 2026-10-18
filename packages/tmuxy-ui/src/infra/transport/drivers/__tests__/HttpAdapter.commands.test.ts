/**
 * Additional HTTP driver tests covering error frames, fatal recovery on
 * session switch, non-JSON error responses, tmux command refusals, network
 * online hints, and invalid state-update frames.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Cause, Effect, Exit, ManagedRuntime, Option, Schedule, Stream } from 'effect';
import { HttpTransportLive } from '../../layers';
import { TmuxTransport, type TmuxTransportService } from '../../TmuxTransport';
import { makeSequencedTransport } from '../../stateFeed';
import { HttpAdapter } from '../HttpAdapter';
import type { ServerState } from '../../../../domain/wire';

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

describe('HttpAdapter commands and recovery', () => {
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

  const stream = async (i: number): Promise<MockEventSource> => {
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(i));
    return MockEventSource.instances[i];
  };

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

  it('a state update that does not decode is a gap: the adapter refetches a full state', async () => {
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
    const runtime = ManagedRuntime.make(HttpTransportLive);
    let last = null as ServerState | null;
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
    const call = <A, E>(f: (t: TmuxTransportService) => Effect.Effect<A, E>) =>
      runtime.runPromise(Effect.flatMap(TmuxTransport, f));

    const connected = call((t) => t.connect);
    await vi.waitFor(() => expect(MockEventSource.instances.length).toBe(1));
    const es = MockEventSource.instances[0];
    es.emit('connection-info', { data: { connection_id: 1 } });
    await connected;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prompt = [[{ c: '$' }]];
    const baseState = {
      session_name: 's',
      active_window_id: '@1',
      active_pane_id: '%1',
      panes: [
        {
          id: 1,
          tmux_id: '%1',
          window_id: '@1',
          content: prompt,
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
        },
      ],
      windows: [{ id: '@1', index: 1, name: 's', active: true, window_type: 'tab' }],
      total_width: 80,
      total_height: 24,
    };
    const initial = call((t) => t.invoke('get_initial_state', { cols: 80, rows: 24 }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer({ ok: true, json: async () => ({ result: baseState }) });
    await initial;
    es.emit('state-update', { data: { type: 'full', state: baseState } });
    // A pane id in the wrong form: nothing past the boundary may see it.
    es.emit('state-update', {
      data: { type: 'delta', delta: { seq: 1, active_pane_id: 'not-a-pane' } },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('state-update'), expect.anything());
    answer({
      ok: true,
      json: async () => ({
        result: {
          ...baseState,
          windows: [
            ...baseState.windows,
            { id: '@7', index: 2, name: 's', active: false, window_type: 'tab' },
          ],
        },
      }),
    });

    await vi.waitFor(() => expect(last?.windows.map((w) => w.id)).toEqual(['@1', '@7']));
    expect(last?.active_pane_id).not.toBe('not-a-pane');
    errors.mockRestore();
    await runtime.dispose();
  });
});
