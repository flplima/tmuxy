/**
 * Sidebar - the LEFT column: a tmux pane running the tabs/panes tree widget.
 *
 * The pane runs `tmuxy widget tree` in its own `sidebar-left`-tagged window, so
 * the tree renders through the ordinary widget path (`SidebarTree` via the
 * registered `tree` widget) while the column still has a real pane identity —
 * something `ctrl+hjkl` and `tmuxy nav` can move into, and the backend can size.
 *
 * Toggled from the header button or `prefix t`; focused by a click, Ctrl+h from
 * the leftmost pane, or a `tmuxy nav left` focus request. See SidebarColumn for
 * the frame the two columns share, and RightSidebar for the pinned terminal.
 */

import { memo, useCallback } from 'react';
import { SidebarColumn } from './SidebarColumn';
import {
  useAppSend,
  useAppSelector,
  selectLeftSidebarPane,
  selectSidebarLayout,
} from '../machines/AppContext';
import { LogProfiler } from '../utils/renderLog';

export const Sidebar = memo(function Sidebar() {
  return (
    <LogProfiler id="Sidebar">
      <SidebarInner />
    </LogProfiler>
  );
});

function SidebarInner() {
  const send = useAppSend();
  const { leftOpen, overlay, leftWidth } = useAppSelector(selectSidebarLayout);
  const focused = useAppSelector((ctx) => ctx.leftSidebarFocused);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const pane = useAppSelector(selectLeftSidebarPane);

  const handleFocus = useCallback(() => send({ type: 'FOCUS_LEFT_SIDEBAR' }), [send]);
  const handleClose = useCallback(() => send({ type: 'TOGGLE_LEFT_SIDEBAR' }), [send]);

  if (!leftOpen) return null;

  return (
    <SidebarColumn
      side="left"
      width={leftWidth}
      overlay={overlay}
      focused={focused}
      pane={pane}
      title={sessionName}
      onFocus={handleFocus}
      onClose={handleClose}
      closeLabel="Close the tree sidebar"
      testId="sidebar-content"
    />
  );
}
