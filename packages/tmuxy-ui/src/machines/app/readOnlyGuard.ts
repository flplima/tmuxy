import type { AppMachineContext } from '../types';

/**
 * Guard for events that would change the session. A read-only client sends
 * tmux nothing (see `tmux/readOnly.ts`), so such an event is dropped whole —
 * before any local side effect it has (a drag preview, a toggled flag, an
 * optimistic focus) can show a change that will never happen.
 */
export const notReadOnly = ({ context }: { context: AppMachineContext }): boolean =>
  !context.readOnly;
