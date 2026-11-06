/**
 * What the app does around an op, read off the op itself: whether its
 * intermediate geometry may animate and whether it re-tiles the window.
 */

import type { TmuxOp } from './commands';
import { commandListParts, isLayoutCommand, runShellScript } from './store/parseCommand';

/** The `pane-group` verbs that restructure windows over several steps. */
const MULTI_STEP_GROUP_VERBS = new Set(['add', 'close', 'switch', 'next', 'prev']);

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
      return commandListParts(op.command).some((part) => {
        const script = runShellScript(part);
        return (
          script !== null &&
          (script.name === 'float-create' ||
            (script.name === 'pane-group' && MULTI_STEP_GROUP_VERBS.has(script.args[0])))
        );
      });
    default:
      return false;
  }
}

/** Ops that re-tile the window (a preset layout), for transient-focus suppression. */
export function isLayoutChange(op: TmuxOp): boolean {
  if (op._tag === 'SelectLayout') return true;
  return op._tag === 'RawCommand' && isLayoutCommand(op.command);
}
