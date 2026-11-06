/**
 * Each column is a real tmux pane in its own tagged window (`sidebar-left` /
 * `sidebar-right`), so `ctrl+hjkl` and `tmuxy nav` can move into it and the
 * backend can size it, while it stays on screen across every tab.
 *
 * RIGHT is created with no command, so tmux starts the default shell in the
 * current pane's directory. Closing it only hides it (`@tmuxy-sidebar-hidden`
 * on its window, so the choice holds across reloads and clients). Keys reach
 * it the way they reach a focused float (the keyboardActor's `overlayPaneId`),
 * never by `select-pane`, which would switch the active tmux window and blank
 * the tab behind it.
 */

import { memo, useCallback } from 'react';
import { SidebarColumn } from './SidebarColumn';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import {
  selectLeftSidebarPane,
  selectRightSidebarPane,
  selectSidebarLayout,
} from '../machines/selectors/panesAndSidebars';
import { LogProfiler } from './renderLog';
import { useSidebarPeekHold } from './useSidebarPeek';

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
  // A peek floats over the pane container, which keeps its size, so tmux
  // re-tiles nothing. The backdrop takes no pointer events: the pointer
  // leaving the column is what ends the peek.
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
