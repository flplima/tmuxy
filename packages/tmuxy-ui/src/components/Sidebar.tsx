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
 * A closed column can also PEEK: shown over the panes, undocked, while the
 * mouse rests on its header toggle or on the column (useSidebarPeek).
 *
 * See SidebarColumn for the frame the two columns share.
 */

import { memo, useCallback } from 'react';
import { SidebarColumn } from './SidebarColumn';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectSidebarLayout,
} from '../machines/selectors/panesAndSidebars';
import { LogProfiler } from '../utils/renderLog';
import { useSidebarPeekHold } from '../hooks/useSidebarPeek';

/** What differs between the two columns, by side. */
const SIDES = {
  left: {
    profilerId: 'Sidebar',
    selectPane: selectLeftSidebarPane,
    focusEvent: 'FOCUS_LEFT_SIDEBAR',
    toggleEvent: 'TOGGLE_LEFT_SIDEBAR',
    testId: 'sidebar-content',
  },
  right: {
    profilerId: 'RightSidebar',
    selectPane: selectRightSidebarPane,
    focusEvent: 'FOCUS_RIGHT_SIDEBAR',
    toggleEvent: 'TOGGLE_RIGHT_SIDEBAR',
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
  const { selectPane, focusEvent, toggleEvent, testId } = SIDES[side];
  const send = useAppSend();
  const layout = useAppSelector(selectSidebarLayout);
  const open = side === 'left' ? layout.leftOpen : layout.rightOpen;
  const width = side === 'left' ? layout.leftWidth : layout.rightWidth;
  const focused = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarFocused : ctx.rightSidebarFocused,
  );
  const startFailed = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarStartFailed : ctx.rightSidebarStartFailed,
  );
  const pane = useAppSelector(selectPane);
  const peeking = useAppSelector((ctx) => ctx.sidebarPeek === side) && !open;
  useSidebarPeekHold(side, peeking);

  const handleFocus = useCallback(() => send({ type: focusEvent }), [send, focusEvent]);
  const handleClose = useCallback(() => send({ type: toggleEvent }), [send, toggleEvent]);

  if (!open && !peeking) return null;

  const column = (
    <SidebarColumn
      side={side}
      width={width}
      focused={focused}
      pane={pane}
      startFailed={startFailed}
      peek={peeking}
      onFocus={handleFocus}
      onClose={handleClose}
      testId={testId}
    />
  );
  if (!peeking) return column;
  // A peek covers the panes rather than docking beside them: the column and a
  // backdrop that dims the rest of the body float over the pane container,
  // which keeps its size, so tmux re-tiles nothing. The backdrop takes no
  // pointer events: the pointer leaving the column is what ends the peek.
  return (
    <>
      <div
        className="sidebar-peek-backdrop"
        aria-hidden="true"
        data-testid="sidebar-peek-backdrop"
      />
      {column}
    </>
  );
}
