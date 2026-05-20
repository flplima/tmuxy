/**
 * Effect-based decoders for the SSE / IPC protocol boundary.
 *
 * Each decoder takes `unknown` (the raw JSON-parsed payload from the wire)
 * and returns Effect<T, ProtocolError>. Failures carry the formatted Schema
 * parse error so the source of the drift is visible in logs and the
 * structured TMUX_ERROR.tagged channel.
 *
 * Usage from a consumer:
 *   const program = decodeStateUpdate(rawPayload).pipe(
 *     Effect.tap((update) => handleStateUpdate(update, ...)),
 *     Effect.catchTag('ProtocolError', (e) => Effect.logError(e.reason)),
 *   );
 */

import { Effect, Schema } from 'effect';
import { ProtocolError } from './AdapterError';
import {
  StateUpdate as StateUpdateSchema,
  ServerState as ServerStateSchema,
  ServerDelta as ServerDeltaSchema,
  KeyBindings as KeyBindingsSchema,
} from './schemas';

/**
 * Generic helper: lift Schema.decodeUnknown into an Effect with our
 * ProtocolError type. Captures the raw payload for forensic debugging.
 */
function decodeWith<A, I>(
  schema: Schema.Schema<A, I>,
  label: string,
): (raw: unknown) => Effect.Effect<A, ProtocolError> {
  const parse = Schema.decodeUnknown(schema, { errors: 'all' });
  return (raw) =>
    parse(raw).pipe(
      Effect.mapError(
        (parseError) =>
          new ProtocolError({
            reason: `${label}: ${parseError.message ?? String(parseError)}`,
            raw,
          }),
      ),
    );
}

export const decodeStateUpdate = decodeWith(StateUpdateSchema, 'StateUpdate');
export const decodeServerState = decodeWith(ServerStateSchema, 'ServerState');
export const decodeServerDelta = decodeWith(ServerDeltaSchema, 'ServerDelta');
export const decodeKeyBindings = decodeWith(KeyBindingsSchema, 'KeyBindings');
