/**
 * String → TmuxOp parser.
 *
 * Replaces the old `optimistic/commandParser.ts`. The intent is the same —
 * recognize the shape of a tmux command string so the store can apply the
 * matching optimistic prediction — but the output is a typed op value, not
 * an internal ParsedCommand struct. The store consumes the op directly;
 * nobody needs to look up "is this command of type X" through a second
 * indirection.
 *
 * This stays as a parser (not a full lexer) on purpose. It only needs to
 * recognize the handful of commands we predict; everything else falls
 * through to `RawCommand` and is forwarded to tmux verbatim, no prediction.
 */

import type { TmuxOp } from './types';

/**
 * Strip the leading `select-pane -t %N \;` prefix that keyboardActor pins to
 * every prefix/root-bound command. Without this, every binding would parse as
 * a `SelectPane` op (the prefix matches first) and the real operation —
 * split-window, swap-pane, new-window — would be lost when the op was turned
 * back into a command string. Returns the binding tail for op-classification
 * purposes; the original command is still what gets sent to tmux.
 */
function stripActivePanePinPrefix(command: string): string {
  const m = command.match(/^select-pane\s+-t\s+%\d+\s+\\;\s*(.+)$/s);
  return m ? m[1] : command;
}

/**
 * Parse a tmux command string to a TmuxOp.
 *
 * Returns a `RawCommand` op for anything we can't or don't want to predict.
 * The caller should ALWAYS call this — the typed-op contract is universal,
 * not optional.
 */
export function parseCommandToOp(command: string): TmuxOp {
  const trimmed = stripActivePanePinPrefix(command.trim());

  // split-window / splitw  (-h = side-by-side / new pane right; -v = stacked / new pane below)
  const splitMatch = trimmed.match(/^(split-window|splitw)\s+(-[hvV])/);
  if (splitMatch) {
    const flag = splitMatch[2].toLowerCase();
    return { _tag: 'Split', direction: flag === '-h' ? 'vertical' : 'horizontal' };
  }

  // select-pane -L/-R/-U/-D — directional navigation
  const navMatch = trimmed.match(/^(select-pane|selectp)\s+-([LRUD])/i);
  if (navMatch) {
    return {
      _tag: 'Navigate',
      direction: navMatch[2].toUpperCase() as 'L' | 'R' | 'U' | 'D',
    };
  }

  // swap-pane -s %X -t %Y (and the reversed -t/-s form)
  const swapForward = trimmed.match(/^(swap-pane|swapp)\s+.*-s\s+(%\d+)\s+.*-t\s+(%\d+)/);
  if (swapForward) {
    return { _tag: 'Swap', sourcePaneId: swapForward[2], targetPaneId: swapForward[3] };
  }
  const swapReverse = trimmed.match(/^(swap-pane|swapp)\s+.*-t\s+(%\d+)\s+.*-s\s+(%\d+)/);
  if (swapReverse) {
    return { _tag: 'Swap', sourcePaneId: swapReverse[3], targetPaneId: swapReverse[2] };
  }

  // select-pane -t [session:]:.+ / :.- — relative cycling. We deliberately don't
  // predict these (client/server drift compounds with each click), but we still
  // recognize them so they go through as RawCommand without misclassification.
  if (/^(select-pane|selectp)\s+-t\s+(?:(?:\S*:)?\.|@\d+\.)\s*[+-]\s*$/.test(trimmed)) {
    return { _tag: 'RawCommand', command };
  }

  // select-pane -t %X — direct focus
  const selectPaneMatch = trimmed.match(/^(select-pane|selectp)\s+-t\s+(%\d+)/);
  if (selectPaneMatch) {
    return { _tag: 'SelectPane', paneId: selectPaneMatch[2] };
  }

  // new-window / neww
  if (/^(new-window|neww)(\s|$)/.test(trimmed)) {
    return { _tag: 'NewWindow' };
  }

  // select-window -t N / selectw -t N (with optional `:` and `=` prefixes)
  const selectWinIdx = trimmed.match(/^(select-window|selectw)\s+-t\s+:?=?(\d+)/);
  if (selectWinIdx) {
    return { _tag: 'SelectWindow', target: parseInt(selectWinIdx[2], 10) };
  }

  if (/^(next-window|nextw|next)(\s|$)/.test(trimmed)) {
    return { _tag: 'SelectWindow', target: 'next' };
  }
  if (/^(previous-window|prevw|prev)(\s|$)/.test(trimmed)) {
    return { _tag: 'SelectWindow', target: 'previous' };
  }

  return { _tag: 'RawCommand', command };
}

/**
 * Render a typed op back to the tmux command string the server will execute.
 * Most ops capture the original string verbatim, but typed ops constructed
 * outside the parser (e.g. SELECT_TAB → SelectWindow{target: index}) need a
 * canonical wire form.
 */
export function toTmuxCommand(op: TmuxOp): string {
  switch (op._tag) {
    case 'Split':
      return op.direction === 'vertical' ? 'split-window -h' : 'split-window -v';
    case 'Navigate':
      return `select-pane -${op.direction}`;
    case 'SelectPane':
      return `select-pane -t ${op.paneId}`;
    case 'Swap':
      return `swap-pane -s ${op.sourcePaneId} -t ${op.targetPaneId}`;
    case 'NewWindow':
      return 'new-window';
    case 'SelectWindow':
      if (op.target === 'next') return 'next-window';
      if (op.target === 'previous') return 'previous-window';
      return `select-window -t ${op.target}`;
    case 'RawCommand':
      return op.command;
  }
}
