/**
 * The `tree` widget. It ignores the pane's content: `tmuxy-widget-tree` prints the
 * marker and blocks, and the tree is derived from the tmux state the app holds.
 * Keyboard focus is the column's (`leftSidebarFocused`), not the pane's.
 */

import { SidebarTree } from '../SidebarTree';
import { useAppSelector } from '../../machines/appHooks';

export function TmuxyTree() {
  const focused = useAppSelector((ctx) => ctx.leftSidebarFocused);
  return <SidebarTree focused={focused} />;
}
