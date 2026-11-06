import type { TmuxOp } from './commands';
import { commandListParts, isLayoutCommand, runShellScript } from './store/parseCommand';

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
      return commandListParts(op.command).some((part) => runShellScript(part)?.effect === 'settle');
    default:
      return false;
  }
}

/** Ops that re-tile the window (a preset layout), for transient-focus suppression. */
export function isLayoutChange(op: TmuxOp): boolean {
  if (op._tag === 'SelectLayout') return true;
  return op._tag === 'RawCommand' && isLayoutCommand(op.command);
}
