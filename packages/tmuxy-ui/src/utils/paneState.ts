/**
 * Pane state — what a pane is doing, as the pane itself declares it.
 *
 * The value comes from the `@tmuxy-pane-state` tmux option, which ANY process
 * can set (`tmuxy pane state working`): an agent's hooks, a shell's
 * precmd/preexec pair, a build script on failure. tmuxy never infers it, which
 * is deliberate — tmux's own activity flag means "bytes arrived", and a spinner
 * produces those continuously, so activity cannot distinguish working from
 * waiting.
 *
 * The vocabulary is deliberately small and the parser deliberately lenient: a
 * writer may send anything, and a value tmuxy does not know collapses to
 * `idle` rather than erroring. That keeps the hook contract loose, so a new
 * agent can write its own status names without waiting for a tmuxy release.
 *
 * Pure: no React, no machine, no adapter.
 */

import type { TmuxPane } from '../domain/client';
import { isPlaceholderId, type PaneId, type WindowId } from '../domain/ids';
import { paneAskFor } from './paneAsk';

export const PANE_STATES = ['needs-input', 'error', 'unread', 'working', 'idle'] as const;

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

/** The glyph a state draws, or null for `working` — the spinner is CSS. */
export const PANE_STATE_GLYPH: Record<PaneStateName, string | null> = {
  'needs-input': '!',
  error: '✗',
  unread: '●',
  working: null,
  idle: '◦',
};

/** Spoken form, for tooltips and assistive technology. */
export const PANE_STATE_LABEL: Record<PaneStateName, string> = {
  'needs-input': 'Needs your input',
  error: 'Failed',
  unread: 'New output',
  working: 'Working',
  idle: 'Idle',
};

const KNOWN = new Set<string>(PANE_STATES);

/**
 * Read a raw option value as a state.
 *
 * Trims and lowercases, accepts `needs_input` and `needsinput` as spellings of
 * `needs-input` (a shell writer reaching for an underscore should not silently
 * get `idle`), and collapses everything else — including an unset option — to
 * `idle`.
 */
export function normalizePaneState(raw: string | null | undefined): PaneStateName {
  if (!raw) return 'idle';
  const value = raw.trim().toLowerCase();
  if (!value) return 'idle';
  const dashed = value.replace(/[\s_]+/g, '-');
  if (KNOWN.has(dashed)) return dashed as PaneStateName;
  if (dashed === 'needsinput') return 'needs-input';
  return 'idle';
}

/**
 * The state a pane is in: whatever it declared, and nothing else.
 *
 * `error` included — a failing build says so itself (`tmuxy pane state error`,
 * from a trap). The obvious alternative, reading a dead pane's exit status,
 * only ever works while tmux's `remain-on-exit` is on, and that keeps every
 * finished pane on screen forever.
 *
 * The one thing tmuxy reads rather than takes on trust is a pending
 * `tmuxy ask`: a pane showing a question IS waiting on the user, whatever it
 * last declared about itself, and it outranks that declaration so the tab
 * holding the question is the one the tree points at.
 */
export function paneStateFor(
  pane: Pick<TmuxPane, 'paneState' | 'paneAsk'>,
  unread = false,
): PaneStateName {
  if (paneAskFor(pane)) return 'needs-input';
  const declared = normalizePaneState(pane.paneState);
  return declared === 'idle' && unread ? 'unread' : declared;
}

type StatePane = Pick<TmuxPane, 'tmuxId' | 'paneState' | 'paneAsk'>;

/**
 * The panes to draw `unread`: those that finished — went from `working` or
 * `needs-input` to `idle` — while the user was in another pane. An agent's
 * hooks only ever say `idle` when it stops; whether anybody saw the result is
 * this side's to judge, since only the client knows which pane is in front.
 *
 * A pane stops being unread when it becomes the active one, or when it
 * declares anything but `idle` again. Returns `unread` itself when nothing
 * changed, so the context keeps its identity.
 */
export function nextUnreadPaneIds(
  unread: readonly PaneId[],
  before: readonly StatePane[],
  after: readonly StatePane[],
  activePaneId: PaneId | null,
): PaneId[] {
  const was = new Map(before.map((p) => [p.tmuxId, paneStateFor(p)]));
  const next = after
    .filter((pane) => {
      if (pane.tmuxId === activePaneId || paneStateFor(pane) !== 'idle') return false;
      if (unread.includes(pane.tmuxId)) return true;
      const previous = was.get(pane.tmuxId);
      return previous === 'working' || previous === 'needs-input';
    })
    .map((pane) => pane.tmuxId);
  const same = next.length === unread.length && next.every((id, i) => id === unread[i]);
  return same ? (unread as PaneId[]) : next;
}

/**
 * Roll several panes up into the one state a tab row shows: the most
 * attention-worthy among them. An empty tab is `idle`.
 */
export function aggregatePaneState(states: readonly PaneStateName[]): PaneStateName {
  let best: PaneStateName = 'idle';
  for (const state of states) {
    if (PANE_STATE_TIER[state] < PANE_STATE_TIER[best]) best = state;
  }
  return best;
}

/**
 * What each tab rolls up to: how many panes it holds, and the most
 * attention-worthy state among them (`aggregatePaneState`'s order, so a
 * question or a failure outranks a pane that is merely working). Placeholder
 * panes — optimistic stand-ins not yet confirmed by tmux — are not counted.
 */
export function tabPaneStates(
  windowIds: readonly WindowId[],
  panes: readonly (StatePane & Pick<TmuxPane, 'windowId'>)[],
  unreadPaneIds: readonly PaneId[],
): Map<WindowId, { count: number; state: PaneStateName }> {
  const out = new Map<WindowId, { count: number; state: PaneStateName }>();
  for (const id of windowIds) {
    const windowPanes = panes.filter((p) => p.windowId === id && !isPlaceholderId(p.tmuxId));
    out.set(id, {
      count: windowPanes.length,
      state: aggregatePaneState(
        windowPanes.map((p) => paneStateFor(p, unreadPaneIds.includes(p.tmuxId))),
      ),
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
