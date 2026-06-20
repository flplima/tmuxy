/**
 * Sidebar - left drawer rendering the `tmuxy tree` TUI pane.
 *
 * The sidebar is a hidden tmux window (windowType === 'sidebar') whose single
 * pane runs the tree TUI. We render that pane's terminal in an edge-docked
 * drawer, mirroring FloatPane's left-drawer branch. Closed by default; toggled
 * from the header button or `prefix t`. When focused (Ctrl+h from the leftmost pane
 * or a click), keystrokes route to the pane and the TUI handles j/k/Enter.
 */

import { useCallback } from 'react';
import { Modal } from './Modal';
import { Terminal } from './Terminal';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectContainerSize,
  selectSidebarPaneId,
} from '../machines/AppContext';
import { SIDEBAR_COLS } from '../machines/constants';
import type { TmuxPane } from '../machines/types';

export function Sidebar() {
  const send = useAppSend();
  const sidebarOpen = useAppSelector((ctx) => ctx.sidebarOpen);
  const sidebarPaneId = useAppSelector(selectSidebarPaneId);
  const focusedSidebarPaneId = useAppSelector((ctx) => ctx.focusedSidebarPaneId);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { height: containerHeight } = useAppSelector(selectContainerSize);

  const pane = useAppSelector((ctx) =>
    sidebarPaneId ? ctx.panes.find((p: TmuxPane) => p.tmuxId === sidebarPaneId) : undefined,
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      send({ type: 'FOCUS_SIDEBAR' });
    },
    [send],
  );

  if (!sidebarOpen || !sidebarPaneId || !pane) return null;

  const isFocused = focusedSidebarPaneId === sidebarPaneId;
  const width = SIDEBAR_COLS * charWidth;
  const terminalRows = Math.floor(containerHeight / charHeight);

  return (
    <Modal
      open={true}
      onClose={() => send({ type: 'TOGGLE_SIDEBAR' })}
      title="tree"
      width={width}
      zIndex={1000}
      className="drawer drawer-left sidebar-drawer"
      containerStyle={{ left: 0, top: 0 }}
      backdrop="none"
      hideHeader
      closeOnEsc={false}
    >
      <div
        className="float-content"
        style={{ width, height: containerHeight }}
        onClick={handleClick}
        data-testid="sidebar-content"
      >
        <Terminal
          content={pane.content}
          cursorX={pane.cursorX}
          cursorY={pane.cursorY}
          isActive={isFocused}
          height={terminalRows}
          inMode={pane.inMode}
          copyCursorX={pane.copyCursorX}
          copyCursorY={pane.copyCursorY}
          cursorShape={pane.cursorShape}
        />
      </div>
    </Modal>
  );
}
