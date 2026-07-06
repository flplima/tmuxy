/**
 * SidebarTree — the left sidebar's tab/pane tree, rendered natively in React.
 *
 * Replaces the old `tmuxy tree` ratatui TUI (which ran in a hidden tmux pane and
 * was rasterized into a terminal). The tree is derived purely from the tmuxy
 * state the app already holds (`selectVisibleWindows` + `selectPanes`) — no tmux
 * window, no child process, no CLI round-trip, no poll. It reflects the same
 * "tabs" the rest of the UI shows (hidden float/group/backdrop windows filtered
 * out by `selectVisibleWindows`).
 *
 * Interactions:
 *  - click a tab → `SELECT_TAB`; click a pane → `select-pane` (tmux switches to
 *    the pane's window too).
 *  - when the sidebar is focused, j/k/↑/↓ move the selection, Enter activates it,
 *    Escape blurs — driven by a capture-phase key listener so the keys never
 *    reach the pane/tmux (the keyboard actor also skips forwarding while focused).
 *  - drag a pane node onto a different tab → `join-pane` moves the pane into that
 *    tab (optimistically, via the store).
 *  - right-click a pane or tab row → the same context menu the pane header /
 *    window tabs show (PaneContextMenu / TabContextMenu).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectVisibleWindows,
  selectPanes,
} from '../machines/AppContext';
import { getTabText, getTabIcon } from './paneTabDisplay';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import type { TmuxPane, TmuxWindow } from '../machines/types';

/** A flattened, keyboard-navigable row: a tab header or one of its panes. */
type Row =
  | { kind: 'tab'; window: TmuxWindow }
  | { kind: 'pane'; pane: TmuxPane; window: TmuxWindow };

/** An open right-click menu targeting a tree row, positioned at the cursor. */
type MenuState =
  | { kind: 'pane'; paneId: string; x: number; y: number }
  | { kind: 'tab'; windowIndex: number; x: number; y: number }
  | null;

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);

  // Flatten tabs → their panes into an ordered row list (the nav order).
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    // Windows are already tab-only and index-ordered by selectVisibleWindows.
    for (const window of windows) {
      out.push({ kind: 'tab', window });
      for (const pane of panes.filter((p) => p.windowId === window.id)) {
        out.push({ kind: 'pane', pane, window });
      }
    }
    return out;
  }, [windows, panes]);

  // Keyboard selection cursor, kept on a stable row identity across refreshes.
  const rowKey = (r: Row) => (r.kind === 'tab' ? r.window.id : r.pane.tmuxId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Default the cursor to the active pane's row when first focused / on change.
  const selectedIndex = useMemo(() => {
    const byKey = rows.findIndex((r) => rowKey(r) === selectedKey);
    if (byKey >= 0) return byKey;
    const byActive = rows.findIndex((r) => r.kind === 'pane' && r.pane.tmuxId === activePaneId);
    return byActive >= 0 ? byActive : 0;
  }, [rows, selectedKey, activePaneId]);

  const activate = useCallback(
    (row: Row) => {
      if (row.kind === 'tab') {
        send({ type: 'SELECT_TAB', windowId: row.window.id, windowIndex: row.window.index });
      } else {
        // select-pane targets a pane in any window and switches to it.
        send({ type: 'SEND_TMUX_COMMAND', command: `select-pane -t ${row.pane.tmuxId}` });
      }
    },
    [send],
  );

  // Move a pane into another tab: join-pane splits that window's active pane and
  // moves the source there (the source window closes if it was its last pane).
  const movePaneToTab = useCallback(
    (paneId: string, targetWindowId: string, targetWindowIndex: number) => {
      send({ type: 'SEND_TMUX_COMMAND', command: `join-pane -s ${paneId} -t ${targetWindowId}` });
      send({ type: 'SELECT_TAB', windowId: targetWindowId, windowIndex: targetWindowIndex });
    },
    [send],
  );

  // Capture-phase keyboard nav while the sidebar is focused (fires before the
  // keyboard actor; stops keys from reaching the pane/tmux).
  const stateRef = useRef({ rows, selectedIndex, activate, send });
  stateRef.current = { rows, selectedIndex, activate, send };
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      const { rows: rs, selectedIndex: idx, activate: act, send: s } = stateRef.current;
      const move = (delta: number) => {
        const next = Math.max(0, Math.min(rs.length - 1, idx + delta));
        if (rs[next]) setSelectedKey(rowKey(rs[next]));
      };
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          e.stopImmediatePropagation();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          e.stopImmediatePropagation();
          move(-1);
          return;
        case 'Enter':
          e.preventDefault();
          e.stopImmediatePropagation();
          if (rs[idx]) act(rs[idx]);
          return;
        case 'Escape':
          e.preventDefault();
          e.stopImmediatePropagation();
          s({ type: 'BLUR_SIDEBAR' });
          return;
        default:
          // The sidebar owns the keyboard while focused — swallow other keys so
          // they don't leak to the terminal (defence-in-depth with the actor).
          e.stopImmediatePropagation();
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focused]);

  // Drag state: which pane is being dragged, and which tab is a hover target.
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [dropWindowId, setDropWindowId] = useState<string | null>(null);

  // Right-click context menu (pane or tab), anchored at the cursor.
  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div
      className="sidebar-tree"
      role="tree"
      aria-label="Tabs and panes"
      data-testid="sidebar-tree"
      data-focused={focused}
    >
      {rows.map((row) => {
        const key = rowKey(row);
        const isSelected = rows[selectedIndex] && rowKey(rows[selectedIndex]) === key;
        if (row.kind === 'tab') {
          const isActive = row.window.id === activeWindowId;
          const isDropTarget = dropWindowId === row.window.id && dragPaneId !== null;
          return (
            <div
              key={`w${key}`}
              role="treeitem"
              aria-selected={isSelected}
              className={`sidebar-tree-tab${isActive ? ' is-active' : ''}${
                isSelected ? ' is-selected' : ''
              }${isDropTarget ? ' is-drop-target' : ''}`}
              data-window-id={row.window.id}
              data-testid={`tree-tab-${row.window.id}`}
              onClick={() => activate(row)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ kind: 'tab', windowIndex: row.window.index, x: e.clientX, y: e.clientY });
              }}
              onDragOver={(e) => {
                if (dragPaneId) {
                  e.preventDefault();
                  setDropWindowId(row.window.id);
                }
              }}
              onDragLeave={() => setDropWindowId((w) => (w === row.window.id ? null : w))}
              onDrop={(e) => {
                e.preventDefault();
                const paneId = e.dataTransfer.getData('text/tmuxy-pane') || dragPaneId;
                if (paneId) movePaneToTab(paneId, row.window.id, row.window.index);
                setDragPaneId(null);
                setDropWindowId(null);
              }}
            >
              <span className="sidebar-tree-twisty" aria-hidden="true">
                ▾
              </span>
              <span className="sidebar-tree-label">
                {row.window.index}:{row.window.name || `Tab ${row.window.index}`}
              </span>
            </div>
          );
        }
        const isActive = row.pane.tmuxId === activePaneId;
        return (
          <div
            key={`p${key}`}
            role="treeitem"
            aria-selected={isSelected}
            className={`sidebar-tree-pane${isActive ? ' is-active' : ''}${
              isSelected ? ' is-selected' : ''
            }${dragPaneId === row.pane.tmuxId ? ' is-dragging' : ''}`}
            data-pane-id={row.pane.tmuxId}
            data-testid={`tree-pane-${row.pane.tmuxId}`}
            draggable
            onClick={() => activate(row)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ kind: 'pane', paneId: row.pane.tmuxId, x: e.clientX, y: e.clientY });
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/tmuxy-pane', row.pane.tmuxId);
              e.dataTransfer.effectAllowed = 'move';
              setDragPaneId(row.pane.tmuxId);
            }}
            onDragEnd={() => {
              setDragPaneId(null);
              setDropWindowId(null);
            }}
          >
            {getTabIcon(row.pane) && (
              <span className="sidebar-tree-icon" aria-hidden="true">
                {getTabIcon(row.pane)}
              </span>
            )}
            <span className="sidebar-tree-label">{getTabText(row.pane)}</span>
          </div>
        );
      })}
      {menu?.kind === 'pane' && (
        <PaneContextMenu paneId={menu.paneId} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
      {menu?.kind === 'tab' && (
        <TabContextMenu windowIndex={menu.windowIndex} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
    </div>
  );
});
