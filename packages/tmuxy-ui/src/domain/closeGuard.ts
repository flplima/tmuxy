/**
 * What a close would interrupt. A pane that says it is `working` or
 * `needs-input` (`@tmuxy-pane-state`, `domain/paneState.ts`) is running
 * something the user would lose by closing it, so a close that ends one is
 * held for a confirmation (`@tmuxy-confirm-close`, on by default). Idle panes,
 * and ones that only failed or have unread output, close at once.
 */

import type { TmuxPane } from './client';
import type { TmuxOp } from './commands';
import { realId, type PaneId, type WindowId } from './ids';
import { BUSY_PANE_STATE_PHRASE, paneStateFor, type PaneStateName } from './paneState';

export interface BusyPane {
  readonly paneId: PaneId;
  /** The program in front (`#{pane_current_command}`). */
  readonly command: string;
  readonly state: PaneStateName;
}

/** A close waiting for the user's answer. */
export interface PendingClose {
  readonly op: TmuxOp;
  /** The exact string the op was parsed from, when a binding issued it. */
  readonly wire: string | undefined;
  readonly scope: 'pane' | 'tab';
  /** The panes it would end that are busy; never empty. */
  readonly busy: readonly BusyPane[];
}

type GuardPane = Pick<TmuxPane, 'tmuxId' | 'windowId' | 'command' | 'paneState' | 'paneAsk'>;

interface GuardModel {
  readonly panes: readonly GuardPane[];
  readonly activePaneId: PaneId | null;
  readonly activeWindowId: WindowId | null;
}

function closedPanes(
  op: TmuxOp,
  model: GuardModel,
): { scope: PendingClose['scope']; panes: readonly GuardPane[] } | null {
  switch (op._tag) {
    case 'KillPane':
    case 'GroupClose': {
      const paneId = op.paneId ?? realId(model.activePaneId);
      return { scope: 'pane', panes: model.panes.filter((p) => p.tmuxId === paneId) };
    }
    case 'KillWindow': {
      const windowId = op.windowId ?? realId(model.activeWindowId);
      return { scope: 'tab', panes: model.panes.filter((p) => p.windowId === windowId) };
    }
    default:
      return null;
  }
}

/**
 * The busy panes `op` would end and whether it closes a pane or a whole tab,
 * or null when it closes nothing busy (or is not a close at all).
 */
export function busyPanesClosedBy(
  op: TmuxOp,
  model: GuardModel,
): Pick<PendingClose, 'scope' | 'busy'> | null {
  const closed = closedPanes(op, model);
  if (!closed) return null;
  const busy = closed.panes
    .map((pane) => ({ paneId: pane.tmuxId, command: pane.command, state: paneStateFor(pane) }))
    .filter((pane) => pane.state in BUSY_PANE_STATE_PHRASE);
  return busy.length > 0 ? { scope: closed.scope, busy } : null;
}
