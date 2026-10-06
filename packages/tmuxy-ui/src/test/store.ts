/**
 * Test helpers for the optimistic store.
 */

import type { TmuxStore } from '../tmux/store';
import { parseCommandToOp } from '../tmux/store/parseCommand';

/**
 * Dispatch a command string the way the app does for a binding: parsed into
 * its op, with the string itself as what goes to tmux.
 */
export const dispatchRaw = (store: TmuxStore, command: string) =>
  store.dispatch(parseCommandToOp(command), { command });
