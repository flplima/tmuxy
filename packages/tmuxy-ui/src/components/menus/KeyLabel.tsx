import { getKeybindingLabel } from './keybindingLabel';
import type { KeyBindings } from '../../machines/types';

/**
 * Right-aligned keybinding hint on a menu item (e.g. `ctrl+b %`).
 * One component — AppMenu, PaneMenuItems, and TabContextMenu used to carry
 * identical private copies.
 */
export function KeyLabel({
  keybindings,
  command,
}: {
  keybindings: KeyBindings | null;
  command: string;
}) {
  const label = getKeybindingLabel(keybindings, command);
  if (!label) return null;
  return <span className="menu-keybinding">{label}</span>;
}
