/**
 * HttpAdapter ordering guarantees.
 *
 * The full adapter pulls in window/EventSource/fetch and is hard to spin up
 * in jsdom. These tests target the one property we actually care about for
 * the split-targeting-wrong-tab bug: when two `run_tmux_command` invokes are
 * fired without awaiting, the second POST must not leave the browser before
 * the first POST's fetch resolves. Otherwise the server can process them
 * out of order and a `split-window -h` issued after a `select-window -t @B`
 * lands in the previous tab.
 *
 * We don't instantiate the full adapter — we replicate the relevant queue
 * shape so the assertion is independent of unrelated SSE/EventSource setup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Schedule } from 'effect';
import { HttpAdapter } from '../HttpAdapter';

interface Resolver<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  promise: Promise<T>;
}

function deferred<T>(): Resolver<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

/** Minimal stand-in for the adapter's enqueueSerialInvoke helper. */
class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    let resolveOuter!: (value: T | PromiseLike<T>) => void;
    let rejectOuter!: (reason: unknown) => void;
    const outer = new Promise<T>((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    this.chain = this.chain.then(async () => {
      try {
        resolveOuter(await run());
      } catch (err) {
        rejectOuter(err);
      }
    });
    return outer;
  }
}

describe('Serialized invoke ordering', () => {
  it('does not start the second fetch until the first resolves', async () => {
    const q = new SerialQueue();
    const firstStart = deferred<void>();
    const firstDone = deferred<string>();
    const secondStart = deferred<void>();
    const secondDone = deferred<string>();

    const first = q.enqueue(async () => {
      firstStart.resolve();
      return firstDone.promise;
    });
    const second = q.enqueue(async () => {
      secondStart.resolve();
      return secondDone.promise;
    });

    await firstStart.promise;
    // Microtask flush — second must not have started yet.
    await Promise.resolve();
    await Promise.resolve();
    const secondStartedEarly = await Promise.race([
      secondStart.promise.then(() => true),
      Promise.resolve(false),
    ]);
    expect(secondStartedEarly).toBe(false);

    firstDone.resolve('a');
    await first;
    await secondStart.promise;
    secondDone.resolve('b');
    await second;

    expect(await first).toBe('a');
    expect(await second).toBe('b');
  });

  it('continues processing the queue after a rejected invoke', async () => {
    const q = new SerialQueue();
    const failing = q.enqueue<string>(() => Promise.reject(new Error('boom')));
    const ok = q.enqueue<string>(() => Promise.resolve('next'));

    await expect(failing).rejects.toThrow('boom');
    expect(await ok).toBe('next');
  });
});

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
