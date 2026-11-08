/**
 * TmuxyTree — the `tree` widget the left sidebar shows. It ignores the pane's
 * content: `packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-tree` prints the marker
 * and then blocks, because the tree is derived from the tmux state the app
 * already holds rather than streamed through the pane.
 *
 * Keyboard focus is the column's, not the pane's: the tree runs its own
 * capture-phase key handling while the column holds the keyboard.
 */

import { SidebarTree } from '../SidebarTree';
import { useAppSelector } from '../../machines/appHooks';
import { selectSidebarHoldsKeyboard } from '../../machines/selectors/keyboard';

export function TmuxyTree() {
  const focused = useAppSelector((ctx) => selectSidebarHoldsKeyboard(ctx, 'left'));
  return <SidebarTree focused={focused} />;
}
