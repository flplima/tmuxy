/**
 * Tagged union of adapter failure modes.
 *
 * The point of typing failures: instead of `catch (e) { logError(e.message) }`
 * everywhere, consumers pattern-match on `_tag` and decide per-case.
 * Adding a new failure mode forces every consumer's switch to be updated
 * (via TypeScript exhaustiveness), preventing the silent-failure bug class.
 *
 * Where each failure comes from:
 *   a failed connect, an HTTP/IPC failure      → TransportError
 *   a command the demo/v86 tmux rejected        → TmuxError
 *   a payload that fails its schema decode      → ProtocolError
 *   a write a read-only session never sends     → Cancelled
 *
 * The HTTP and Tauri transports never reject with a TmuxError: a mutation is
 * acknowledged once it is written to control mode, and tmux's own rejection
 * arrives later on the event stream (`tmux-error`), not as the invoke's
 * answer. Their rejections — a missing monitor, a blocked command, an HTTP
 * error status — are transport failures, and a failed read's tmux message
 * is not told apart from those on the wire.
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

/** An AdapterError as the one human-readable line logs and the snackbar show. */
export function formatAdapterError(e: AdapterError): string {
  switch (e._tag) {
    case 'TmuxError':
      return `${e.command}: ${e.stderr}`;
    case 'TransportError':
      return e.context ? `${e.context}: ${String(e.cause)}` : String(e.cause);
    case 'ProtocolError':
      return `protocol error: ${e.reason}`;
    case 'Cancelled':
      return e.reason ? `cancelled: ${e.reason}` : 'cancelled';
  }
}

/**
 * Best-effort coercion of a Promise rejection into a typed AdapterError.
 *
 * The adapters reject with various shapes (Error instances, plain strings
 * from Tauri IPC, `{ error: '...' }` objects from the demo and v86 tmux).
 * This helper picks the most accurate _tag based on shape; when in doubt it
 * falls back to TransportError, never throws.
 */
export function classifyAdapterError(cause: unknown, context?: { command?: string }): AdapterError {
  // Already-tagged Effect errors pass through unchanged.
  if (cause instanceof TransportError) return cause;
  if (cause instanceof ProtocolError) return cause;
  if (cause instanceof TmuxError) return cause;
  if (cause instanceof Cancelled) return cause;

  // The demo and v86 adapters reject a command their tmux refused as
  //   { error: 'no such pane: %999' }
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
