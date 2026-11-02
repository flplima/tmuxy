import type { KeyBindings } from '../wire';
import { toTmuxCommand, type TmuxOp } from '../commands';
import { parseCommandToOp } from '../store/parseCommand';
import { getKeybindingLabel } from '../../components/menus/keybindingLabel';

/**
 * The key hint for an op: the binding whose command is the op's own, so an
 * item and its hint cannot disagree. Undefined when nothing is bound to it.
 *
 * A bound command is compared as the op it parses to, spelled back out: a
 * binding to `kill-window` is the close-tab op even though the op's own
 * command ends in the stash sweep the binding does not spell.
 */
export function keyHint(keybindings: KeyBindings | null, op: TmuxOp): string | undefined {
  return getKeybindingLabel(keybindings, toTmuxCommand(op), (action) =>
    toTmuxCommand(parseCommandToOp(action)),
  );
}
