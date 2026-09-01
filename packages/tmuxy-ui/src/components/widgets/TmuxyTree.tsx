/**
 * TmuxyTree — the `tree` widget: the tabs+panes tree the left sidebar shows.
 *
 * Registered like any other tmuxy widget, so a pane running `tmuxy widget tree`
 * renders this component instead of its terminal. Unlike the image and markdown
 * widgets it ignores the pane's content entirely: `bin/tmuxy/tmuxy-widget-tree`
 * prints the marker and then blocks, because the tree is derived from the tmux
 * state the app already holds rather than streamed through the pane.
 *
 * Keyboard focus is the column's, not the pane's — the tree runs its own
 * capture-phase key handling while `leftSidebarFocused` is set, exactly as it
 * did before the column became a pane.
 */

import { SidebarTree } from '../SidebarTree';
import { useAppSelector } from '../../machines/AppContext';

export function TmuxyTree() {
  const focused = useAppSelector((ctx) => ctx.leftSidebarFocused);
  return <SidebarTree focused={focused} />;
}
