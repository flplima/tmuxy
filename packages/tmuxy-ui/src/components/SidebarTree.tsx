/**
 * SidebarTree — tmux tree orchestration with optional Git decoration.
 *
 * Pure grouping/flattening lives in sidebarTreeModel; row-specific rendering
 * and interaction state live in SidebarTreeRows; capture-phase navigation lives
 * in useSidebarTreeKeyboard. This component only binds those pieces to XState.
 */

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  selectPanes,
  selectRepositories,
  selectSessions,
  selectVisibleWindows,
  useAppSelector,
  useAppSelectorShallow,
  useAppSend,
} from '../machines/AppContext';
import {
  createSidebarTreeIndex,
  flattenSidebarTree,
  indexLivePanesByWindow,
  rowKey,
  type SidebarTreeIndex,
  type SidebarTreeRow,
} from './sidebarTreeModel';
import { SidebarTreeRows } from './SidebarTreeRows';
import { useSidebarTreeKeyboard } from './useSidebarTreeKeyboard';

interface SidebarTreeProps {
  focused: boolean;
  /** Reuse the index already built for the sidebar header when available. */
  index?: SidebarTreeIndex;
}

export const SidebarTree = memo(function SidebarTree({
  focused,
  index: sharedIndex,
}: SidebarTreeProps) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const sessionName = useAppSelector((context) => context.sessionName);
  const activePaneId = useAppSelector((context) => context.activePaneId);
  const activeWindowId = useAppSelector((context) => context.activeWindowId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const index = useMemo(
    () => sharedIndex ?? createSidebarTreeIndex(sessions, repositories),
    [repositories, sessions, sharedIndex],
  );
  const livePanesByWindow = useMemo(() => indexLivePanesByWindow(panes), [panes]);
  const rows = useMemo(
    () =>
      flattenSidebarTree({
        index,
        windows,
        sessions,
        sessionName,
        collapsed,
        livePanesByWindow,
      }),
    [collapsed, index, livePanesByWindow, sessionName, sessions, windows],
  );

  const selectedIndex = useMemo(() => {
    const byKey = rows.findIndex((row) => rowKey(row) === selectedKey);
    if (byKey >= 0) return byKey;
    const byActive = rows.findIndex(
      (row) => row.kind === 'pane' && row.pane.tmuxId === activePaneId,
    );
    return byActive >= 0 ? byActive : 0;
  }, [activePaneId, rows, selectedKey]);

  const activate = useCallback(
    (row: SidebarTreeRow) => {
      setSelectedKey(rowKey(row));
      switch (row.kind) {
        case 'tab':
          send({ type: 'SELECT_TAB', windowId: row.window.id, windowIndex: row.window.index });
          return;
        case 'pane':
          if (row.window.id !== activeWindowId) {
            send({
              type: 'SELECT_TAB',
              windowId: row.window.id,
              windowIndex: row.window.index,
            });
          }
          send({
            type: 'SEND_TMUX_COMMAND',
            command: `select-pane -t ${row.pane.tmuxId}`,
          });
          return;
        case 'session':
          if (!row.active) send({ type: 'SWITCH_SESSION', sessionName: row.name });
          return;
        case 'foreign-tab':
          send({
            type: 'SWITCH_SESSION',
            sessionName: row.sessionName,
            windowId: row.windowId,
          });
          return;
        case 'foreign-pane':
          send({
            type: 'SWITCH_SESSION',
            sessionName: row.sessionName,
            windowId: row.windowId,
            paneId: row.paneId,
          });
          return;
      }
    },
    [activeWindowId, send],
  );

  const toggleExpanded = useCallback((row: SidebarTreeRow) => {
    const key = rowKey(row);
    setSelectedKey(key);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const movePaneToTab = useCallback(
    (paneId: string, targetWindowId: string, targetWindowIndex: number) => {
      send({ type: 'SEND_TMUX_COMMAND', command: `join-pane -s ${paneId} -t ${targetWindowId}` });
      send({ type: 'SELECT_TAB', windowId: targetWindowId, windowIndex: targetWindowIndex });
    },
    [send],
  );
  const blur = useCallback(() => send({ type: 'BLUR_SIDEBAR' }), [send]);
  const focusRow = useCallback((index: number) => {
    treeRef.current?.querySelector<HTMLElement>(`[data-tree-row-index="${index}"]`)?.focus();
  }, []);

  useSidebarTreeKeyboard({
    focused,
    rows,
    selectedIndex,
    collapsed,
    setSelectedKey,
    focusRow,
    activate,
    toggleExpanded,
    blur,
  });

  return (
    <div
      ref={treeRef}
      className="sidebar-tree"
      role="tree"
      aria-label="Sessions, windows and panes"
      data-testid="sidebar-tree"
      data-focused={focused}
    >
      <SidebarTreeRows
        rows={rows}
        selectedIndex={selectedIndex}
        collapsed={collapsed}
        activePaneId={activePaneId}
        activeWindowId={activeWindowId}
        onSelectKey={setSelectedKey}
        onActivate={activate}
        onToggleExpanded={toggleExpanded}
        onMovePaneToTab={movePaneToTab}
      />
    </div>
  );
});
