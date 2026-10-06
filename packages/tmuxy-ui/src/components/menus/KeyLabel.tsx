import { getKeybindingLabel } from './keybindingLabel';
import type { KeyBindings } from '../../machines/types';
import { toTmuxCommand, type TmuxOp } from '../../domain/commands';

/**
 * Right-aligned keybinding hint on a menu item (e.g. `ctrl+b %`): the key
 * bound to the command `op` renders to — the very op the item dispatches.
 * One component — AppMenu, PaneMenuItems, and TabContextMenu used to carry
 * identical private copies.
 */
export function KeyLabel({ keybindings, op }: { keybindings: KeyBindings | null; op: TmuxOp }) {
  const label = getKeybindingLabel(keybindings, toTmuxCommand(op));
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}
