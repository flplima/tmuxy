/**
 * What a pane is doing, as the pane itself declares it: the `@tmuxy-pane-state`
 * tmux option, which ANY process
 * can set (`tmuxy pane state working`): an agent's hooks, a shell's
 * precmd/preexec pair, a build script on failure. tmuxy never infers it, which
 * is deliberate — tmux's own activity flag means "bytes arrived", and a spinner
 * produces those continuously, so activity cannot distinguish working from
 * waiting.
 *
 * The vocabulary is core's `PaneStateName`, generated into
 * `tmuxyConstants.gen.ts`, and it is read exactly as core reads it: the word
 * as written, or `idle`. `tmuxy pane state` refuses any other word, so a
 * near-miss reaches tmux only through a raw `set-option`, and then the tab,
 * the push notification and the screen corrector all read it the same way.
 */

import type { TmuxPane } from './client';
import { isPlaceholderId, type WindowId } from './ids';
import { paneSendFor } from './paneAsk';
import { PANE_STATES } from './tmuxyConstants.gen';

export type PaneStateName = (typeof PANE_STATES)[number];

/**
 * Attention tier — LOWER sorts first, and the lowest tier present wins when
 * several panes roll up into one tab badge.
 *
 * The ordering is the useful part: a tab holding both a pane that wants an
 * answer and a pane that failed reads as `needs-input`, because the question
 * is the thing only you can resolve. An error is already over; the question is
 * still blocking.
 */
export const PANE_STATE_TIER: Record<PaneStateName, number> = {
  'needs-input': 0,
  error: 1,
  unread: 2,
  working: 3,
  idle: 4,
};

/** The glyph a state draws: none for `idle`, and `working` is a spinner
 *  (`components/PaneStateMark.tsx`). The two that want the user are Nerd Font
 *  icons from the shipped FiraCode Nerd Font: the filled warning triangle
 *  (nf-fa-warning) and the filled circled x (nf-fa-times_circle). */
export const PANE_STATE_GLYPH: Record<PaneStateName, string | null> = {
  'needs-input': '\u{f071}',
  error: '\u{f057}',
  unread: '●',
  working: null,
  idle: null,
};

export const PANE_STATE_LABEL: Record<PaneStateName, string> = {
  'needs-input': 'Needs your input',
  error: 'Failed',
  unread: 'New output',
  working: 'Working',
  idle: 'Idle',
};

const KNOWN = new Set<string>(PANE_STATES);

export function readPaneState(raw: string | null | undefined): PaneStateName {
  return raw && KNOWN.has(raw) ? (raw as PaneStateName) : 'idle';
}

/**
 * Whatever the pane declared, `error` included — a failing build says so itself (`tmuxy pane state error`,
 * from a trap). The obvious alternative, reading a dead pane's exit status,
 * only ever works while tmux's `remain-on-exit` is on, and that keeps every
 * finished pane on screen forever.
 *
 * The one thing tmuxy reads rather than takes on trust is a pending
 * `tmuxy pane send -t`: a pane showing a question IS waiting on the user, whatever it
 * last declared about itself, and it outranks that declaration so the tab
 * holding the question is the one the tree points at.
 *
 * An agent that finishes is `idle`, whether or not the user was looking: its
 * pane wears its process icon again, and nothing is left to dismiss.
 */
export function paneStateFor(pane: Pick<TmuxPane, 'paneState' | 'paneAsk'>): PaneStateName {
  if (paneSendFor(pane)) return 'needs-input';
  return readPaneState(pane.paneState);
}

type StatePane = Pick<TmuxPane, 'tmuxId' | 'paneState' | 'paneAsk'>;

export function aggregatePaneState(states: readonly PaneStateName[]): PaneStateName {
  let best: PaneStateName = 'idle';
  for (const state of states) {
    if (PANE_STATE_TIER[state] < PANE_STATE_TIER[best]) best = state;
  }
  return best;
}

/** Placeholder panes, not yet confirmed by tmux, are not counted. */
export function tabPaneStates(
  windowIds: readonly WindowId[],
  panes: readonly (StatePane & Pick<TmuxPane, 'windowId'>)[],
): Map<WindowId, { count: number; state: PaneStateName }> {
  const out = new Map<WindowId, { count: number; state: PaneStateName }>();
  for (const id of windowIds) {
    const windowPanes = panes.filter((p) => p.windowId === id && !isPlaceholderId(p.tmuxId));
    out.set(id, {
      count: windowPanes.length,
      state: aggregatePaneState(windowPanes.map((p) => paneStateFor(p))),
    });
  }
  return out;
}

/**
 * A tab's position as a circled numeral — ➊ to ➓, then ⓫ to ⓴ — and as a plain
 * number past those.
 */
export function circledNumber(n: number): string {
  if (n >= 1 && n <= 10) return String.fromCodePoint(0x278a + n - 1);
  if (n >= 11 && n <= 20) return String.fromCodePoint(0x24eb + n - 11);
  return String(n);
}
