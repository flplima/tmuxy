/**
 * What the app does around an op, read off the op itself: whether its
 * intermediate geometry may animate, and whether its rollback is a change
 * the user sees.
 */

import type { TmuxOp } from './commands';
import { scriptEffect } from './commandHelpers';

/**
 * Ops that run a multi-step server script or create a window, whose
 * intermediate geometry must not animate. A raw string (a key binding's,
 * an essentials alias expanded) by the effect its script run is marked with.
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
      return scriptEffect(op.command) === 'settle';
    default:
      return false;
  }
}

/**
 * Ops whose predicted patch moves the layout (as opposed to a focus pin): a
 * rollback of one visibly reverts the screen, so it is reported to the user.
 * Every op `domain/store/ops.ts` predicts a layout for is here.
 */
export function isStructural(op: TmuxOp): boolean {
  switch (op._tag) {
    case 'Split':
    case 'NewWindow':
    case 'KillPane':
    case 'KillWindow':
    case 'RenameWindow':
    case 'MoveWindow':
    case 'ZoomToggle':
    case 'Swap':
    case 'GroupSwitch':
    case 'GroupMove':
      return true;
    default:
      return false;
  }
}
