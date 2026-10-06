/**
 * The transport as an Effect service: what the app asks of a backend, with
 * typed failures, and everything the backend pushes as one ordered stream.
 *
 * Each backend is a driver (`TmuxAdapter`) — an SSE stream and POSTs, Tauri
 * IPC, the demo engine, a v86 guest — and `makeTransport` lifts one into this
 * service exactly once: every call becomes an Effect failing with an
 * `AdapterError` classified from the backend's `{ error, kind }`, and the
 * driver's event hub is published on a `PubSub` for whoever subscribes. The
 * Layers that pick a driver are in `layers.ts`.
 */

import { Context, Effect, PubSub, Schema, type Scope, Stream } from 'effect';
import type { TmuxAdapter } from '../../tmux/types';
import {
  type AdapterError,
  ProtocolError,
  TransportError,
  classifyAdapterError,
} from '../../tmux/effect/AdapterError';
import type { TransportEvent } from './events';

export interface TmuxTransportService {
  /** Open the connection; resolves once the backend has greeted this client. */
  readonly connect: Effect.Effect<void, AdapterError>;
  readonly disconnect: Effect.Effect<void>;
  /** Send a command and await its answer. */
  readonly invoke: <T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ) => Effect.Effect<T, AdapterError>;
  /**
   * Invoke a command AND decode the answer against its schema in
   * `domain/wire.ts` (e.g. get_scrollback_cells, get_theme_settings). A
   * mismatch is a ProtocolError carrying the raw payload, distinct from
   * TransportError / TmuxError.
   */
  readonly decodingInvoke: <A, I>(
    cmd: string,
    schema: Schema.Schema<A, I>,
    args?: Record<string, unknown>,
  ) => Effect.Effect<A, AdapterError>;
  /** Read from tmux (see `TmuxAdapter.query`); a TransportError where it cannot (demo, v86). */
  readonly query: (command: string) => Effect.Effect<string, AdapterError>;
  readonly switchSession: (sessionName: string) => Effect.Effect<void, AdapterError>;
  /** Retry a dropped connection now rather than at the next backoff tick. */
  readonly reconnectNow: Effect.Effect<void>;
  /** The backend serves this client as a viewer; known once connected. */
  readonly isReadOnly: () => boolean;
  /** Attached to a real tmux server whose sessions can be listed (web, desktop). */
  readonly enumeratesSessions: () => boolean;
  /**
   * Subscribe now, consume later: the subscription is taken when this runs,
   * so a caller that connects afterwards misses nothing the connection says.
   * The stream carries every pushed event in arrival order, the decoded and
   * sequenced state (`State`) among them.
   */
  readonly subscribe: Effect.Effect<Stream.Stream<TransportEvent>, never, Scope.Scope>;
}

export class TmuxTransport extends Context.Tag('tmuxy/TmuxTransport')<
  TmuxTransport,
  TmuxTransportService
>() {}

/** The service over `driver`, publishing the driver's events until the scope closes. */
export const makeTransport = (
  driver: TmuxAdapter,
): Effect.Effect<TmuxTransportService, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<TransportEvent>(),
      PubSub.shutdown,
    );
    const unsubscribe = driver.events.subscribe((event) => {
      pubsub.unsafeOffer(event);
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const attempt = <A>(command: string, run: () => Promise<A>): Effect.Effect<A, AdapterError> =>
      Effect.tryPromise({ try: run, catch: (cause) => classifyAdapterError(cause, { command }) });
    const unsupported = (what: string, context: string) =>
      Effect.fail(new TransportError({ cause: `${what} not supported by this adapter`, context }));

    return {
      connect: attempt('connect', () => driver.connect()),
      disconnect: Effect.sync(() => driver.disconnect()),
      invoke: <T>(cmd: string, args?: Record<string, unknown>) =>
        attempt(cmd, () => driver.invoke<T>(cmd, args)),
      decodingInvoke: <A, I>(
        cmd: string,
        schema: Schema.Schema<A, I>,
        args?: Record<string, unknown>,
      ) => {
        const decode = Schema.decodeUnknown(schema, { errors: 'all' });
        return attempt(cmd, () => driver.invoke<unknown>(cmd, args)).pipe(
          Effect.flatMap((raw) =>
            decode(raw).pipe(
              Effect.mapError(
                (parseError) => new ProtocolError({ reason: `${cmd}: ${parseError.message}`, raw }),
              ),
            ),
          ),
        );
      },
      query: (command: string) =>
        driver.query
          ? attempt(command, () => driver.query!(command))
          : unsupported('query', command),
      switchSession: (sessionName: string) =>
        driver.switchSession
          ? attempt('switchSession', () => driver.switchSession!(sessionName))
          : unsupported('switchSession', 'switchSession'),
      reconnectNow: Effect.sync(() => driver.reconnectNow?.()),
      isReadOnly: () => driver.readOnly === true,
      enumeratesSessions: () => driver.enumeratesSessions === true,
      subscribe: Stream.fromPubSub(pubsub, { scoped: true }),
    };
  });
