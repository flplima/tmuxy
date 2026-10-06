/**
 * Tagged union of adapter failure modes.
 *
 * The point of typing failures: instead of `catch (e) { logError(e.message) }`
 * everywhere, consumers pattern-match on `_tag` and decide per-case.
 * Adding a new failure mode forces every consumer's switch to be updated
 * (via TypeScript exhaustiveness), preventing the silent-failure bug class.
 *
 * Every transport rejects a command the backend refused with the same shape,
 * `{ error, kind }` (`CommandFailure` in `domain/wire.ts`): the HTTP adapter
 * throws the `POST /commands` error body, a Tauri command rejects with it,
 * and the demo and v86 sandboxes reject with it too. `kind` decides the tag:
 *
 *   kind `tmux` — tmux itself rejected the command  → TmuxError
 *   kind `unavailable` — no tmux connection          → TransportError
 *   kind `invalid` / `forbidden` — the server refused → TransportError,
 *     its context naming the refusal so the user sees why
 *   a failed connect, a non-JSON HTTP error, IPC loss → TransportError
 *   a payload that fails its schema decode           → ProtocolError
 *   a write a read-only session never sends          → Cancelled
 *
 * A mutation is acknowledged once it is written to control mode, so tmux's
 * rejection of one arrives later on the event stream (`tmux-error`); a read
 * (`query_tmux`) is answered in-band and rejects with kind `tmux`.
 */

import { Data, Option, Schema } from 'effect';
import { CommandFailure } from '../../domain/wire';

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

const decodeCommandFailure = Schema.decodeUnknownOption(CommandFailure);

/** The tagged error for a command the backend refused. */
function fromCommandFailure(command: string, failure: CommandFailure): AdapterError {
  switch (failure.kind) {
    case 'tmux':
      return new TmuxError({ command, stderr: failure.error });
    case 'unavailable':
      return new TransportError({ cause: failure.error, context: command });
    case 'invalid':
    case 'forbidden':
      return new TransportError({
        cause: failure.error,
        context: `${command} refused (${failure.kind})`,
      });
  }
}

/**
 * Coerce a Promise rejection into a typed AdapterError: an AdapterError
 * passes through, a `{ error, kind }` command failure is tagged by its kind,
 * and anything else (a network error, a lost IPC channel) is a
 * TransportError. Never throws.
 */
export function classifyAdapterError(cause: unknown, context?: { command?: string }): AdapterError {
  if (
    cause instanceof TransportError ||
    cause instanceof ProtocolError ||
    cause instanceof TmuxError ||
    cause instanceof Cancelled
  ) {
    return cause;
  }
  const failure = decodeCommandFailure(cause);
  if (Option.isSome(failure)) {
    return fromCommandFailure(context?.command ?? '<unknown>', failure.value);
  }
  return new TransportError({
    cause: cause instanceof Error ? cause.message : cause,
    context: context?.command,
  });
}
