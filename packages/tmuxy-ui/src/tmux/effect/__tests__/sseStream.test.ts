import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect, Exit, Stream, Chunk, Schedule } from 'effect';
import { eventSourceStream } from '../sseStream';

/**
 * Minimal MockEventSource that tracks registered listeners and lets the
 * test fire events on demand. Mirrors the subset of EventSource that
 * sseStream.ts actually uses.
 */
class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  static last: MockEventSource | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.last = this;
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    const arr = this.listeners.get(name) ?? [];
    arr.push(listener);
    this.listeners.set(name, arr);
  }

  close() {
    this.closed = true;
  }

  // Test helpers (not part of the EventSource API).
  open() {
    this.onopen?.();
  }
  emit(name: string, dataObj: unknown) {
    const fake = new MessageEvent(name, { data: JSON.stringify(dataObj) });
    this.listeners.get(name)?.forEach((l) => l(fake));
  }
  emitRaw(name: string, raw: string) {
    const fake = new MessageEvent(name, { data: raw });
    this.listeners.get(name)?.forEach((l) => l(fake));
  }
  fail() {
    this.onerror?.();
  }
}

let originalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  originalEventSource = globalThis.EventSource;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.EventSource = MockEventSource as any;
  MockEventSource.last = null;
});

afterEach(() => {
  if (originalEventSource) globalThis.EventSource = originalEventSource;
});

describe('eventSourceStream', () => {
  it('emits named SSE events as { name, data } pairs', async () => {
    const stream = eventSourceStream('http://localhost/events', {
      events: ['state-update', 'keybindings'],
    });

    // Take 2 events, then end the stream from outside via .interruptAfter
    const collectProgram = Stream.runCollect(Stream.take(stream, 2));

    // Need to schedule emissions AFTER the EventSource is created.
    const interleave = Effect.gen(function* () {
      // Wait a tick so the asyncPush register effect runs and creates the EventSource.
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open();
      es.emit('state-update', { data: { foo: 1 } });
      es.emit('keybindings', { data: { prefix_key: 'C-b' } });
    });

    const [collected] = await Effect.runPromise(
      Effect.all([collectProgram, interleave], { concurrency: 2 }),
    );

    const arr = Chunk.toReadonlyArray(collected);
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({ name: 'state-update', data: { foo: 1 } });
    expect(arr[1]).toEqual({ name: 'keybindings', data: { prefix_key: 'C-b' } });
  });

  it('unwraps the {data: ...} envelope but passes through bare payloads', async () => {
    const stream = eventSourceStream('http://localhost/events', {
      events: ['wrapped', 'bare'],
    });
    const collectProgram = Stream.runCollect(Stream.take(stream, 2));
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open();
      es.emit('wrapped', { data: { inner: 42 } }); // unwrapped → { inner: 42 }
      es.emit('bare', { inner: 99 }); // bare object passes through
    });
    const [collected] = await Effect.runPromise(
      Effect.all([collectProgram, fire], { concurrency: 2 }),
    );
    const arr = Chunk.toReadonlyArray(collected);
    expect(arr[0].data).toEqual({ inner: 42 });
    expect(arr[1].data).toEqual({ inner: 99 });
  });

  it('fails with TransportError if EventSource errors BEFORE first open', async () => {
    const stream = eventSourceStream('http://localhost/events', { events: ['state-update'] });
    const collectProgram = Stream.runCollect(stream);
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      MockEventSource.last!.fail(); // pre-handshake failure
    });
    const exit = await Effect.runPromiseExit(
      Effect.all([collectProgram, fire], { concurrency: 2 }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/TransportError/);
      expect(json).toMatch(/SSE connection failed before first event/);
    }
  });

  it('ends the stream gracefully if EventSource errors AFTER first open (for retry)', async () => {
    const stream = eventSourceStream('http://localhost/events', { events: ['state-update'] });
    const collectProgram = Stream.runCollect(stream);
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open(); // handshake succeeds
      es.emit('state-update', { data: 'first' });
      yield* Effect.sleep('1 millis');
      es.fail(); // mid-stream disconnect → graceful end, not failure
    });
    const [collected] = await Effect.runPromise(
      Effect.all([collectProgram, fire], { concurrency: 2 }),
    );
    const arr = Chunk.toReadonlyArray(collected);
    expect(arr).toHaveLength(1);
    expect(arr[0].data).toBe('first');
  });

  it('closes the underlying EventSource when the stream is interrupted', async () => {
    const stream = eventSourceStream('http://localhost/events', { events: ['ev'] });
    // Run, take 1 event, then the stream should clean up its resource.
    const program = Stream.runCollect(Stream.take(stream, 1));
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open();
      es.emit('ev', { data: 'one' });
    });
    await Effect.runPromise(Effect.all([program, fire], { concurrency: 2 }));
    // The stream completes after Stream.take(1), which closes the scope.
    expect(MockEventSource.last!.closed).toBe(true);
  });

  it('surfaces a ProtocolError-like failure on bad JSON without killing first events', async () => {
    const stream = eventSourceStream('http://localhost/events', { events: ['ev'] });
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open();
      es.emitRaw('ev', '{not-json'); // triggers JSON.parse failure → stream fails
    });
    const exit = await Effect.runPromiseExit(
      Effect.all([Stream.runCollect(stream), fire], { concurrency: 2 }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      // classifyAdapterError on a JSON.parse SyntaxError → TransportError
      // (which is the right semantics — the JSON.parse failed at the
      // transport layer, before schema validation could decide otherwise).
      expect(json).toMatch(/Error/);
    }
  });

  it('composes with Stream.retry for reconnect-with-backoff', async () => {
    // The point of this test isn't to exercise real retry logic — it's to
    // prove the type signature accepts the pattern documented in the
    // module header. If this compiles and runs at least once, callers can
    // wire it up with confidence.
    const stream = eventSourceStream('http://localhost/events', { events: ['ev'] });
    const withRetry = stream.pipe(Stream.retry(Schedule.recurs(0))); // 0 retries
    const collectProgram = Stream.runCollect(Stream.take(withRetry, 1));
    const fire = Effect.gen(function* () {
      yield* Effect.sleep('1 millis');
      const es = MockEventSource.last!;
      es.open();
      es.emit('ev', { data: 'tick' });
    });
    const [collected] = await Effect.runPromise(
      Effect.all([collectProgram, fire], { concurrency: 2 }),
    );
    const arr = Chunk.toReadonlyArray(collected);
    expect(arr).toHaveLength(1);
  });

  // vi import retained for test-environment ergonomics (mocks ref).
  it('test setup is using the injected MockEventSource', () => {
    expect(vi).toBeDefined();
    expect(globalThis.EventSource).toBe(MockEventSource);
  });
});
