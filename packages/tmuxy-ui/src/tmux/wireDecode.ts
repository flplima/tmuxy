/**
 * Decoding at the boundary: where a payload from the backend enters the
 * client, it goes through its schema in `domain/wire.ts` exactly once. Every
 * transport (HTTP/SSE, Tauri IPC, the demo and v86 sandboxes) calls these, so
 * nothing past an adapter ever sees an unchecked payload.
 *
 * A payload that does not match is a `ProtocolError`. It is never thrown into
 * a listener: a state update that fails is treated like a sequence gap (the
 * adapter resyncs from a full state), any other event is logged and dropped.
 */

import { Either, ParseResult, Schema } from 'effect';
import { ServerState, StateUpdate } from '../domain/wire';
import { ProtocolError } from './effect/AdapterError';

/** Each mismatch as `path: message`, e.g. `delta.active_pane_id: Expected a string matching …`. */
function describeMismatch(error: ParseResult.ParseError): string {
  return ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function toProtocolError(what: string, raw: unknown, error: ParseResult.ParseError): ProtocolError {
  return new ProtocolError({ reason: `${what}: ${describeMismatch(error)}`, raw });
}

/** Decode `raw` against `schema`, naming the payload `what` in the error. */
export function decodeWire<A, I>(
  schema: Schema.Schema<A, I>,
  what: string,
): (raw: unknown) => Either.Either<A, ProtocolError> {
  const decode = Schema.decodeUnknownEither(schema);
  return (raw) => Either.mapLeft(decode(raw), (error) => toProtocolError(what, raw, error));
}

/** One `state-update` payload (full or delta). */
export const decodeStateUpdate = decodeWire(StateUpdate, 'state-update');

/** A full state (the `get_initial_state` answer, a sandbox engine's snapshot). */
export const decodeServerState = decodeWire(ServerState, 'server state');

/** Report a payload that failed its decode; the caller then drops or resyncs. */
export function logProtocolError(error: ProtocolError): void {
  console.error(`[tmuxy] ${error.reason}`, error.raw);
}

/**
 * Decode an event payload for a listener: the decoded value, or null after
 * logging when it does not match (the event is dropped).
 */
export function decodeEvent<A, I>(
  schema: Schema.Schema<A, I>,
  what: string,
): (raw: unknown) => A | null {
  const decode = decodeWire(schema, what);
  return (raw) =>
    Either.match(decode(raw), {
      onLeft: (error) => {
        logProtocolError(error);
        return null;
      },
      onRight: (value) => value,
    });
}

/** A full state for a listener, or null (logged) when it does not decode. */
export const decodeStateForListener = decodeEvent(ServerState, 'server state');

/** A full state as a command's answer: rejects with the ProtocolError when it does not decode. */
export function decodeServerStateOrThrow(raw: unknown): ServerState {
  return Either.getOrThrowWith(decodeServerState(raw), (error) => error);
}
