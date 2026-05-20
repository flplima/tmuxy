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
 *   const program = eff.invoke<TmuxState>('get_initial_state');
 *   Effect.runPromiseExit(program).then(exit => { ... });
 *
 * Cancellation: when the surrounding fiber is interrupted, the wrapper does
 * NOT cancel the in-flight Promise (Promises aren't cancellable). It DOES
 * stop the Effect from completing — the result is dropped. This is the
 * pragmatic baseline; future work (Phase E2) can replace specific adapter
 * calls with native Effect / Stream implementations for true cancellation.
 */

import { Effect } from 'effect';
import type { TmuxAdapter } from '../types';
import {
  type AdapterError,
  TransportError,
  classifyAdapterError,
} from './AdapterError';

export interface EffectTmuxAdapter {
  /** Open the connection. Wraps adapter.connect(). */
  connect: () => Effect.Effect<void, AdapterError>;

  /** Synchronous teardown of subscriptions and timers. */
  disconnect: () => void;

  /** Send a command and await its response with typed errors. */
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Effect.Effect<T, AdapterError>;

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

    disconnect: () => adapter.disconnect(),

    invoke: <T>(cmd: string, args?: Record<string, unknown>) =>
      Effect.tryPromise<T, AdapterError>({
        try: () => adapter.invoke<T>(cmd, args),
        catch: (cause) => classifyAdapterError(cause, { command: cmd }),
      }),

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
