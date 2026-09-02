/**
 * RightSidebar - the pinned terminal column.
 *
 * A real tmux pane in a `sidebar-right`-tagged window, created on first open by
 * the same `split-window ; break-pane ; set-option` list a float uses — with no
 * command, so tmux starts the default shell in the current pane's directory and
 * the column opens exactly like a freshly split pane.
 *
 * Because the pane lives in its own window rather than the active one, it stays
 * on screen across every tab — which is the point: a terminal or TUI you pin
 * once and keep reachable from anywhere in the session. Closing the column only
 * HIDES it (`@tmuxy-sidebar-hidden` on its window, so the choice holds across
 * reloads and clients); the shell is killed by exiting it, which the sidebar
 * lifecycle in appMachine then retracts the column for.
 *
 * Keys reach it through the same overlay mechanism a focused float uses (the
 * keyboardActor's `overlayPaneId`) — never `select-pane`, which would switch the
 * active tmux window and blank the tab behind it.
 */

import { memo, useCallback } from 'react';
import { SidebarColumn } from './SidebarColumn';
import { getTabText } from './paneTabDisplay';
import {
  useAppSend,
  useAppSelector,
  selectRightSidebarPane,
  selectSidebarLayout,
} from '../machines/AppContext';
import { LogProfiler } from '../utils/renderLog';

export const RightSidebar = memo(function RightSidebar() {
  return (
    <LogProfiler id="RightSidebar">
      <RightSidebarInner />
    </LogProfiler>
  );
});

function RightSidebarInner() {
  const send = useAppSend();
  const { rightOpen, overlay, rightWidth } = useAppSelector(selectSidebarLayout);
  const focused = useAppSelector((ctx) => ctx.rightSidebarFocused);
  const startFailed = useAppSelector((ctx) => ctx.rightSidebarStartFailed);
  const pane = useAppSelector(selectRightSidebarPane);

  const handleFocus = useCallback(() => send({ type: 'FOCUS_RIGHT_SIDEBAR' }), [send]);
  const handleClose = useCallback(() => send({ type: 'TOGGLE_RIGHT_SIDEBAR' }), [send]);

  if (!rightOpen) return null;

  return (
    <SidebarColumn
      side="right"
      width={rightWidth}
      overlay={overlay}
      focused={focused}
      pane={pane}
      startFailed={startFailed}
      title={pane ? getTabText(pane) : 'shell'}
      onFocus={handleFocus}
      onClose={handleClose}
      closeLabel="Close the pinned terminal"
      testId="right-sidebar-content"
    />
  );
}
