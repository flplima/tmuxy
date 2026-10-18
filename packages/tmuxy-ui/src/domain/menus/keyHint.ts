import type { KeyBindings } from '../wire';
import { toTmuxCommand, type TmuxOp } from '../commands';
import { getKeybindingLabel } from '../../components/menus/keybindingLabel';

/**
 * The key hint for an op: the binding whose command is the op's own, so an
 * item and its hint cannot disagree. Undefined when nothing is bound to it.
 */
export function keyHint(keybindings: KeyBindings | null, op: TmuxOp): string | undefined {
  return getKeybindingLabel(keybindings, toTmuxCommand(op));
}
