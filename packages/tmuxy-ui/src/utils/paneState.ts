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

import type { TmuxPane } from '../tmux/types';
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
export function paneStateFor(pane: Pick<TmuxPane, 'paneState' | 'paneAsk'>): PaneStateName {
  if (paneAskFor(pane)) return 'needs-input';
  return normalizePaneState(pane.paneState);
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

/** Whether a state is worth drawing at all — `idle` is the quiet default. */
export function isNoteworthy(state: PaneStateName): boolean {
  return state !== 'idle';
}
