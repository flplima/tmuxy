/**
 * Effect-based facade over the Promise-based TmuxAdapter.
 *
 * Rather than rewriting every adapter (Tauri/HTTP/Demo) twice, we wrap their
 * existing Promise-returning methods in Effect with typed AdapterError. This
 * lets consumers opt into Effect's structured concurrency / typed errors /
 * cancellation without forcing a big-bang adapter rewrite.
 *
 * Usage:
 *   const eff = toEffectAdapter(adapter);
 *   const program = eff.invoke<ServerState>('get_initial_state');
 *   Effect.runPromiseExit(program).then(exit => { ... });
 *
 * Cancellation: when the surrounding fiber is interrupted, the wrapper does
 * NOT cancel the in-flight Promise (Promises aren't cancellable). It DOES
 * stop the Effect from completing — the result is dropped.
 */

import { Effect, Schema } from 'effect';
import type { TmuxAdapter } from '../types';
import {
  type AdapterError,
  ProtocolError,
  TransportError,
  classifyAdapterError,
} from './AdapterError';

export interface EffectTmuxAdapter {
  /** Open the connection. Wraps adapter.connect(). */
  connect: () => Effect.Effect<void, AdapterError>;

  /** Send a command and await its response with typed errors. */
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Effect.Effect<T, AdapterError>;

  /**
   * Invoke a command AND decode the answer against its schema in
   * `domain/wire.ts` (e.g. get_scrollback_cells, get_theme_settings). A
   * mismatch surfaces as ProtocolError carrying the raw payload, distinct
   * from TransportError / TmuxError. Plain `invoke` is for commands whose
   * answer is nothing (fire-and-forget) or that the adapter already decodes
   * (get_initial_state).
   */
  decodingInvoke: <A, I>(
    cmd: string,
    schema: Schema.Schema<A, I>,
    args?: Record<string, unknown>,
  ) => Effect.Effect<A, AdapterError>;

  /**
   * Read from tmux: the command's output, typed errors. Fails with a
   * TransportError on adapters that cannot read (demo, v86).
   */
  query: (command: string) => Effect.Effect<string, AdapterError>;

  /** Optional: switch active tmux session. */
  switchSession: (sessionName: string) => Effect.Effect<void, AdapterError>;
}

export function toEffectAdapter(adapter: TmuxAdapter): EffectTmuxAdapter {
  return {
    connect: () =>
      Effect.tryPromise({
        try: () => adapter.connect(),
        catch: (cause) => classifyAdapterError(cause, { command: 'connect' }),
      }),

    invoke: <T>(cmd: string, args?: Record<string, unknown>) =>
      Effect.tryPromise<T, AdapterError>({
        try: () => adapter.invoke<T>(cmd, args),
        catch: (cause) => classifyAdapterError(cause, { command: cmd }),
      }),

    decodingInvoke: <A, I>(
      cmd: string,
      schema: Schema.Schema<A, I>,
      args?: Record<string, unknown>,
    ) => {
      const decode = Schema.decodeUnknown(schema, { errors: 'all' });
      return Effect.tryPromise<unknown, AdapterError>({
        try: () => adapter.invoke<unknown>(cmd, args),
        catch: (cause) => classifyAdapterError(cause, { command: cmd }),
      }).pipe(
        Effect.flatMap((raw) =>
          decode(raw).pipe(
            Effect.mapError(
              (parseError) =>
                new ProtocolError({
                  reason: `${cmd}: ${parseError.message ?? String(parseError)}`,
                  raw,
                }),
            ),
          ),
        ),
      );
    },

    query: (command: string) =>
      adapter.query
        ? Effect.tryPromise<string, AdapterError>({
            try: () => adapter.query!(command),
            catch: (cause) => classifyAdapterError(cause, { command }),
          })
        : Effect.fail(
            new TransportError({
              cause: 'query not supported by this adapter',
              context: command,
            }),
          ),

    switchSession: (sessionName: string) =>
      adapter.switchSession
        ? Effect.tryPromise<void, AdapterError>({
            try: () => adapter.switchSession!(sessionName),
            catch: (cause) => classifyAdapterError(cause, { command: 'switchSession' }),
          })
        : Effect.fail(
            new TransportError({
              cause: 'switchSession not supported by this adapter',
              context: 'switchSession',
            }),
          ),
  };
}
