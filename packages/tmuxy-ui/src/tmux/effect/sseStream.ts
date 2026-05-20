/**
 * Effect Stream wrapper around browser EventSource.
 *
 * What this buys us over raw addEventListener:
 *
 * 1. Structured cancellation. When the surrounding Effect fiber is
 *    interrupted (or its enclosing Scope closes), the EventSource is closed
 *    deterministically via Effect.acquireRelease — no manual unsubscribe
 *    plumbing, no risk of leaking SSE connections after session switch.
 *
 * 2. Backpressure via the underlying queue. If the consumer falls behind
 *    (e.g. heavy render frame), events pile up in Stream's bounded buffer
 *    instead of being dropped on the floor or flooding the event loop.
 *
 * 3. Composable retry. Reconnect-with-exponential-backoff becomes
 *    `stream.pipe(Stream.retry(Schedule.exponential('1 second')))` at the
 *    call site, instead of ad-hoc setTimeout chains spread across the
 *    adapter.
 *
 * 4. Schema decoding fits naturally. `.pipe(Stream.mapEffect(decodeWith(...)))`
 *    turns the raw stream into a typed-event stream with ProtocolError
 *    failures, all in the same pipeline.
 *
 * The EventSource itself is not replaced — browsers don't expose a
 * cancellable native Stream and the EventSource API is good enough for SSE.
 * This wrapper just lifts it into Effect's world.
 */

import { Effect, Stream } from 'effect';
import {
  type AdapterError,
  TransportError,
  classifyAdapterError,
} from './AdapterError';

/**
 * One emit from an SSE Stream. `name` is the SSE `event:` field
 * (e.g. 'state-update', 'keybindings'). `data` is the JSON-parsed payload —
 * the server wraps real data in `{ data: ... }`, so we unwrap one level
 * to match the convention used by HttpAdapter and TauriAdapter.
 */
export interface SseEvent {
  readonly name: string;
  readonly data: unknown;
}

export interface SseStreamOptions {
  /**
   * Event names to subscribe to. The browser's EventSource only routes
   * named events to listeners registered for that exact name; an unnamed
   * 'message' listener catches the rest. We list explicit names rather
   * than catch-all so unknown event types are visible as a TS-level miss.
   */
  readonly events: readonly string[];
  /**
   * Buffer size for the underlying queue. `"unbounded"` matches the old
   * addEventListener behavior (no drop). A finite number activates
   * backpressure: when the consumer falls behind, the chosen strategy
   * decides what happens.
   */
  readonly bufferSize?:
    | 'unbounded'
    | { readonly bufferSize: number; readonly strategy: 'dropping' | 'sliding' };
}

/**
 * Build an SSE Stream from a URL and an event name allowlist.
 *
 * Failure semantics:
 *  - If the EventSource fails BEFORE receiving the first event, the stream
 *    fails with TransportError (the SSE handshake failed).
 *  - If it fails AFTER the first event (mid-stream disconnect), the stream
 *    ENDS rather than failing — server-side disconnects are expected during
 *    reconnect cycles, and the caller wraps with Stream.retry(...) if they
 *    want auto-reconnect.
 *  - JSON parse errors on individual events are surfaced as ProtocolError
 *    in the stream values, not as stream-terminating errors.
 */
export function eventSourceStream(
  url: string,
  options: SseStreamOptions,
): Stream.Stream<SseEvent, AdapterError> {
  const bufferOpt =
    options.bufferSize === undefined
      ? { bufferSize: 'unbounded' as const }
      : options.bufferSize === 'unbounded'
        ? { bufferSize: 'unbounded' as const }
        : { bufferSize: options.bufferSize.bufferSize, strategy: options.bufferSize.strategy };

  return Stream.asyncPush<SseEvent, AdapterError>(
    (emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const es = new EventSource(url);
          let opened = false;

          es.onopen = () => {
            opened = true;
          };

          es.onerror = () => {
            if (!opened) {
              // Pre-handshake failure: the connect itself failed. End the
              // stream with a TransportError so the caller can decide
              // whether to retry (Stream.retry) or surface the error.
              void emit.fail(
                new TransportError({
                  cause: 'SSE connection failed before first event',
                  context: url,
                }),
              );
            } else {
              // Mid-stream disconnect: end gracefully so retry policies kick in.
              void emit.end();
            }
          };

          for (const name of options.events) {
            es.addEventListener(name, (event) => {
              if (!(event instanceof MessageEvent)) return;
              let payload: unknown;
              try {
                payload = JSON.parse(event.data);
              } catch (cause) {
                // Don't kill the whole stream on one bad event — surface it
                // as a stream-level error and let the consumer decide.
                void emit.fail(classifyAdapterError(cause, { command: `sse:${name}` }));
                return;
              }
              // Server wraps real data in { data: ... } — unwrap one level
              // if present, matching the prior addEventListener convention.
              const unwrapped =
                payload !== null &&
                typeof payload === 'object' &&
                'data' in payload &&
                (payload as { data: unknown }).data !== undefined
                  ? (payload as { data: unknown }).data
                  : payload;
              void emit.single({ name, data: unwrapped });
            });
          }

          return es;
        }),
        (es) => Effect.sync(() => es.close()),
      ),
    bufferOpt,
  );
}
