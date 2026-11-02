/**
 * What the app does around an op, read off the op itself: whether its
 * intermediate geometry may animate and whether it re-tiles the window.
 */

import type { TmuxOp } from './commands';

/**
 * Ops that run a multi-step server script or create a window, whose
 * intermediate geometry must not animate. A raw string is classified by the
 * scripts it names.
 */
export function isMultiStep(op: TmuxOp): boolean {
  switch (op._tag) {
    case 'NewWindow':
    case 'GroupAdd':
    case 'GroupClose':
    case 'GroupSwitch':
    case 'GroupStep':
      return true;
    case 'RawCommand':
      return (
        /^run-shell\b/.test(op.command) &&
        /pane-group'? (add|close|switch|next|prev)|float-create/.test(op.command)
      );
    default:
      return false;
  }
}

/** Ops that re-tile the window (a preset layout), for transient-focus suppression. */
export function isLayoutChange(op: TmuxOp): boolean {
  if (op._tag === 'SelectLayout') return true;
  return (
    op._tag === 'RawCommand' &&
    /^(next-layout|previous-layout|select-layout|selectl)\b/.test(op.command)
  );
}
