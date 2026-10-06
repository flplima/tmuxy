/**
 * Test helpers for branded ids and wire payloads.
 *
 * Tests write ids and wire objects as plain literals and pass them through
 * the real schemas, exactly as a payload enters the client — so a fixture
 * that would not decode fails here instead of slipping past the boundary.
 */

import { Schema } from 'effect';
import { GroupId, PaneId, WindowId } from '../domain/ids';
import { ServerDelta, ServerState, StateUpdate } from '../domain/wire';

/** A pane id literal (`%N`). */
export const pid = (id: string): PaneId => PaneId.make(id);
/** A window id literal (`@N`). */
export const wid = (id: string): WindowId => WindowId.make(id);
/** A group id literal (`gN`). */
export const gid = (id: string): GroupId => GroupId.make(id);

/** Decode a full-state literal. */
export const wireState = Schema.decodeSync(ServerState);
/** Decode a delta literal. */
export const wireDelta = Schema.decodeSync(ServerDelta);
/** Decode a `state-update` payload (a literal or a fixture read from disk). */
export const wireUpdate = Schema.decodeUnknownSync(StateUpdate);
