/**
 * What a close would interrupt. A pane that says it is `working` or
 * `needs-input` (`@tmuxy-pane-state`, `domain/paneState.ts`) is running
 * something the user would lose by closing it, so a close that ends one is
 * held for a confirmation (`@tmuxy-confirm-close`, on by default). Idle panes,
 * and ones that only failed or have unread output, close at once.
 *
 * What is asked about: tmuxy's own close ops, and a command string as far as
 * `closedByCommand` reads it. A close tmux runs without the client (a shell's
 * `tmuxy pane kill`, another client) is not seen here at all.
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
  /** What it closes: one pane, one tab, or more than the client can name (`kill-pane -a`). */
  readonly scope: 'pane' | 'tab' | 'several';
  /** The panes it would end that are busy; never empty. */
  readonly busy: readonly BusyPane[];
}

type GuardPane = Pick<TmuxPane, 'tmuxId' | 'windowId' | 'command' | 'paneState' | 'paneAsk'>;

export interface GuardModel {
  readonly panes: readonly GuardPane[];
  /** The pane a close with no target acts on: the one the keyboard is in. */
  readonly focusPaneId: PaneId | null;
  readonly activeWindowId: WindowId | null;
  /** The op came as a command string (a binding, the prompt), not from a menu. */
  readonly typed: boolean;
  readonly sessionName: string;
}

interface Closed {
  readonly scope: PendingClose['scope'];
  readonly panes: readonly GuardPane[];
}

/** One command of a raw string that ends programs, as far as the client reads tmux's syntax. */
const KILL =
  /^(kill-pane|killp|kill-window|killw|kill-session|kill-server|respawn-pane|respawnp|respawn-window|respawnw)\b(.*)$/;

/**
 * What a command the parser left as a string would end. Only an exact pane
 * (`-t %N`) or tab (`-t @N`) is resolved; `-a` is everything else in the
 * window or the session; any other target (an index, a name) could be any
 * pane, so every pane counts. A respawn ends a program only with `-k`. Not
 * read: a verb shortened to a prefix (`kill-p`), and a kill wrapped in another
 * command (`if-shell`, `run-shell`, `confirm-before`).
 */
function closedByCommand(command: string, model: GuardModel): Closed | null {
  const match = KILL.exec(command.trim());
  if (!match) return null;
  const [, verb, rest] = match;
  if (verb.startsWith('respawn') && !/(^|\s)-\w*k/.test(rest)) return null;
  const flags: KillFlags = {
    target: /(?:^|\s)-t\s*(\S+)/.exec(rest)?.[1],
    others: /(^|\s)-\w*a/.test(rest),
  };
  if (/^kill-(session|server)$/.test(verb)) return closedBySessionKill(verb, flags, model);
  return /^(kill-pane|killp|respawn-pane|respawnp)$/.test(verb)
    ? closedByPaneKill(flags, model)
    : closedByWindowKill(flags, model);
}

/** A kill's `-t` target as written, and whether `-a` turns it into "every other". */
interface KillFlags {
  readonly target: string | undefined;
  readonly others: boolean;
}

/**
 * Another session's panes are not this client's to count, unless `-a` makes
 * this one of "every other session".
 */
function closedBySessionKill(verb: string, flags: KillFlags, model: GuardModel): Closed | null {
  const named = flags.target?.replace(/^=|:$/g, '');
  const elsewhere = /session/.test(verb) && named !== undefined && named !== model.sessionName;
  return elsewhere === flags.others ? { scope: 'several', panes: model.panes } : null;
}

function closedByPaneKill({ target, others }: KillFlags, model: GuardModel): Closed {
  if (target && !/^%\d+$/.test(target)) return { scope: 'several', panes: model.panes };
  const paneId = target ?? model.focusPaneId;
  if (!others) return { scope: 'pane', panes: model.panes.filter((p) => p.tmuxId === paneId) };
  const windowId = model.panes.find((p) => p.tmuxId === paneId)?.windowId;
  return {
    scope: 'several',
    panes: model.panes.filter((p) => p.windowId === windowId && p.tmuxId !== paneId),
  };
}

function closedByWindowKill({ target, others }: KillFlags, model: GuardModel): Closed {
  if (target && !/^@\d+$/.test(target)) return { scope: 'several', panes: model.panes };
  const windowId = target ?? model.activeWindowId;
  return others
    ? { scope: 'several', panes: model.panes.filter((p) => p.windowId !== windowId) }
    : { scope: 'tab', panes: model.panes.filter((p) => p.windowId === windowId) };
}

/** A raw string is a command list: each command of it is read on its own. */
function closedByRaw(command: string, model: GuardModel): Closed | null {
  const parts = command
    .split(/\s*\\?;\s*/)
    .map((part) => closedByCommand(part, model))
    .filter((part): part is Closed => part !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  const panes = new Set(parts.flatMap((part) => part.panes));
  return { scope: 'several', panes: [...panes] };
}

function closedPanes(op: TmuxOp, model: GuardModel): Closed | null {
  switch (op._tag) {
    case 'KillPane':
    case 'GroupClose': {
      const paneId = op.paneId ?? realId(model.focusPaneId);
      return { scope: 'pane', panes: model.panes.filter((p) => p.tmuxId === paneId) };
    }
    case 'KillWindow': {
      const windowId = op.windowId ?? realId(model.activeWindowId);
      return { scope: 'tab', panes: model.panes.filter((p) => p.windowId === windowId) };
    }
    case 'KillSession':
      // The menu's Kill Session asks every time itself; a typed one asks here.
      // Another session's panes are not this client's to count.
      return model.typed && (!op.name || op.name === model.sessionName)
        ? { scope: 'several', panes: model.panes }
        : null;
    case 'RawCommand':
      return closedByRaw(op.command, model);
    default:
      return null;
  }
}

/**
 * The busy panes `op` would end and how much it closes, or null when it
 * closes nothing busy (or is not a close at all).
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

/**
 * The question as the panes are now: null once nothing it named is still
 * busy (the agent finished, the pane exited), so a stale one is not left up.
 */
export function stillPending(
  pending: PendingClose | null,
  panes: readonly GuardPane[],
): PendingClose | null {
  if (!pending) return null;
  const busy = pending.busy.filter((held) => {
    const pane = panes.find((p) => p.tmuxId === held.paneId);
    return pane !== undefined && paneStateFor(pane) in BUSY_PANE_STATE_PHRASE;
  });
  if (busy.length === pending.busy.length) return pending;
  return busy.length > 0 ? { ...pending, busy } : null;
}
