/**
 * Tagged union of adapter failure modes.
 *
 * The point of typing failures: instead of `catch (e) { logError(e.message) }`
 * everywhere, consumers pattern-match on `_tag` and decide per-case.
 * Adding a new failure mode forces every consumer's switch to be updated
 * (via TypeScript exhaustiveness), preventing the silent-failure bug class.
 *
 * Mapping from the old string-error world:
 *   "Failed to connect to Tauri"              → TransportError
 *   adapter.invoke() promise rejection         → TransportError | TmuxError
 *   JSON.parse / delta-protocol parse failure  → ProtocolError
 *   manual disconnect / session-switch abort   → Cancelled
 */

import { Data } from 'effect';

export class TransportError extends Data.TaggedError('TransportError')<{
  readonly cause: unknown;
  readonly context?: string;
}> {}

export class ProtocolError extends Data.TaggedError('ProtocolError')<{
  readonly raw?: unknown;
  readonly reason: string;
}> {}

export class TmuxError extends Data.TaggedError('TmuxError')<{
  readonly command: string;
  readonly stderr: string;
}> {}

export class Cancelled extends Data.TaggedError('Cancelled')<{
  readonly reason?: string;
}> {}

export type AdapterError = TransportError | ProtocolError | TmuxError | Cancelled;

/**
 * Best-effort coercion of a Promise rejection into a typed AdapterError.
 *
 * The Tauri/HTTP/Demo adapters reject with various shapes (Error subclasses,
 * plain strings, structured `{ error: '...' }` objects from the Rust backend).
 * This helper picks the most accurate _tag based on shape; when in doubt it
 * falls back to TransportError, never throws.
 */
export function classifyAdapterError(
  cause: unknown,
  context?: { command?: string },
): AdapterError {
  // Already-tagged Effect errors pass through unchanged.
  if (cause instanceof TransportError) return cause;
  if (cause instanceof ProtocolError) return cause;
  if (cause instanceof TmuxError) return cause;
  if (cause instanceof Cancelled) return cause;

  // Rust backend convention: tmux command failures come back as
  //   { error: 'no such pane: %999' }
  // (see packages/tmuxy-server/src/sse.rs command response shape).
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'error' in cause &&
    typeof (cause as { error: unknown }).error === 'string'
  ) {
    return new TmuxError({
      command: context?.command ?? '<unknown>',
      stderr: (cause as { error: string }).error,
    });
  }

  // Plain-string rejection.
  if (typeof cause === 'string') {
    return new TransportError({ cause, context: context?.command });
  }

  // Error instance.
  if (cause instanceof Error) {
    return new TransportError({ cause, context: context?.command ?? cause.message });
  }

  // Unknown shape — keep the original cause for debugging.
  return new TransportError({ cause, context: context?.command });
}
