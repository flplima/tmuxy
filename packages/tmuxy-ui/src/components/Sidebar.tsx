/**
 * Sidebar - one of the two columns beside the pane grid, each a real tmux pane
 * in its own tagged window (`sidebar-left` / `sidebar-right`), so it has a pane
 * identity — something `ctrl+hjkl` and `tmuxy nav` can move into, and the
 * backend can size — while staying on screen across every tab.
 *
 * LEFT runs `tmuxy widget tree`, and draws the tabs/panes tree (`SidebarTree`)
 * over that pane. Toggled from the header button or `prefix t`; focused by a
 * click, Ctrl+h from the leftmost pane, or a `tmuxy nav left` focus request.
 *
 * RIGHT is the pinned terminal: created on first open by the same `split-window
 * ; break-pane ; set-option` list a float uses — with no command, so tmux starts
 * the default shell in the current pane's directory and the column opens
 * exactly like a freshly split pane. A terminal or TUI you pin once and keep
 * reachable from anywhere in the session. Closing the column only HIDES it
 * (`@tmuxy-sidebar-hidden` on its window, so the choice holds across reloads
 * and clients); the shell is killed by exiting it, which the sidebar lifecycle
 * in appMachine then retracts the column for. Keys reach it through the same
 * overlay mechanism a focused float uses (the keyboardActor's `overlayPaneId`)
 * — never `select-pane`, which would switch the active tmux window and blank
 * the tab behind it.
 *
 * See SidebarColumn for the frame the two columns share.
 */

import { memo, useCallback } from 'react';
import { SidebarColumn } from './SidebarColumn';
import { sidebarShellTitle } from './paneTabDisplay';
import {
  useAppSend,
  useAppSelector,
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectSidebarLayout,
} from '../machines/AppContext';
import { LogProfiler } from '../utils/renderLog';

/** What differs between the two columns, by side. */
const SIDES = {
  left: {
    profilerId: 'Sidebar',
    selectPane: selectLeftSidebarPane,
    focusEvent: 'FOCUS_LEFT_SIDEBAR',
    toggleEvent: 'TOGGLE_LEFT_SIDEBAR',
    closeLabel: 'Close the tree sidebar',
    testId: 'sidebar-content',
  },
  right: {
    profilerId: 'RightSidebar',
    selectPane: selectRightSidebarPane,
    focusEvent: 'FOCUS_RIGHT_SIDEBAR',
    toggleEvent: 'TOGGLE_RIGHT_SIDEBAR',
    closeLabel: 'Close the pinned terminal',
    testId: 'right-sidebar-content',
  },
} as const;

export const Sidebar = memo(function Sidebar({ side }: { side: 'left' | 'right' }) {
  return (
    <LogProfiler id={SIDES[side].profilerId}>
      <SidebarInner side={side} />
    </LogProfiler>
  );
});

function SidebarInner({ side }: { side: 'left' | 'right' }) {
  const { selectPane, focusEvent, toggleEvent, closeLabel, testId } = SIDES[side];
  const send = useAppSend();
  const layout = useAppSelector(selectSidebarLayout);
  const open = side === 'left' ? layout.leftOpen : layout.rightOpen;
  const closing = side === 'left' ? layout.leftClosing : layout.rightClosing;
  const width = side === 'left' ? layout.leftWidth : layout.rightWidth;
  const focused = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarFocused : ctx.rightSidebarFocused,
  );
  const startFailed = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarStartFailed : ctx.rightSidebarStartFailed,
  );
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const pane = useAppSelector(selectPane);

  const handleFocus = useCallback(() => send({ type: focusEvent }), [send, focusEvent]);
  const handleClose = useCallback(() => send({ type: toggleEvent }), [send, toggleEvent]);

  if (!open && !closing) return null;

  return (
    <SidebarColumn
      side={side}
      width={width}
      closing={closing}
      moving={layout.motion}
      overlay={layout.overlay}
      focused={focused}
      pane={pane}
      startFailed={startFailed}
      // The tree's column is named after the session it lists; the terminal's
      // after what it is running.
      title={side === 'left' ? sessionName : sidebarShellTitle(pane)}
      onFocus={handleFocus}
      onClose={handleClose}
      closeLabel={closeLabel}
      testId={testId}
    />
  );
}
