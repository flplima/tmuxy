/**
 * Adapter between wire-format ServerState (snake_case) and TmuxSnapshot
 * (camelCase, store-internal). Re-uses the existing `transformServerState`
 * helper that already handles the snake → camel conversion + sort.
 */

import { transformServerState as _transform } from '../../machines/app/helpers';
import type { ServerState } from '../types';
import type { TmuxSnapshot } from './types';

export function transformServerState(payload: ServerState): TmuxSnapshot {
  // The helper returns mutable arrays; TmuxSnapshot is `readonly`. The cast
  // is safe — the store never mutates the snapshot in place, it returns
  // fresh objects from reducers.
  return _transform(payload) as TmuxSnapshot;
}
