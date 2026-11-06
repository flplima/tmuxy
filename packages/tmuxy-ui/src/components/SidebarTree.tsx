/**
 * The attached session's own tabs and panes, never the socket's other
 * sessions: no key in the tree could reach them and no state behind them could
 * draw them. Switching session is the session switcher's (`SessionMenu.tsx`).
 *
 * Escape is never a tree key: a sidebar pane may run a program that needs it.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePendingMove } from './sidebarTreePendingMove';
import { TmuxOp } from '../domain/commands';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useBindingOwnsKey,
} from '../machines/appHooks';
import { selectVisibleWindows } from '../machines/selectors/panesAndSidebars';
import { selectPanes } from '../machines/selectors/layout';
import { selectSessions, selectRepositories } from '../machines/selectors/ui';
import { tabPaneStates } from '../domain/paneState';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import type { PaneId, WindowId } from '../domain/ids';
import { useReorderDrag } from './useReorderDrag';
import { tabWalksChrome } from '../infra/dom/chromeTab';
import { isRealFormControl } from '../machines/actors/keyboard/keyFormatting';
import {
  rowDomId,
  rowKey,
  useSidebarGitContext,
  type MenuState,
  type Row,
  buildTreeRows,
} from './sidebarTreeRows';
import { SidebarTreeRow } from './SidebarTreeRow';

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const collapsedTabIds = useAppSelectorShallow((ctx) => ctx.collapsedTabIds);
  const paneGroups = useAppSelector((ctx) => ctx.paneGroups);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const bindingOwnsKey = useBindingOwnsKey();

  const collapsed = useMemo(() => new Set(collapsedTabIds), [collapsedTabIds]);
  const { cwdByPane, branchOf } = useSidebarGitContext(sessions, sessionName, repositories);

  const tabSummaries = useMemo(
    () =>
      tabPaneStates(
        windows.map((w) => w.id),
        panes,
      ),
    [windows, panes],
  );

  // A pane dropped on another tab is shown under that tab from the drop on:
  // `join-pane` has no geometry the client could predict for the grid, so the
  // move is held for the tree alone until the pane's window agrees.
  const { pendingMove, startMove } = usePendingMove(panes);

  const rows = useMemo<Row[]>(() => {
    const placed = pendingMove
      ? panes.map((p) =>
          p.tmuxId === pendingMove.paneId ? { ...p, windowId: pendingMove.windowId } : p,
        )
      : panes;
    return buildTreeRows(windows, placed, collapsed, paneGroups);
  }, [windows, panes, collapsed, pendingMove, paneGroups]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = useMemo(() => {
    const byKey = rows.findIndex((r) => rowKey(r) === selectedKey);
    if (byKey >= 0) return byKey;
    const byActive = rows.findIndex((r) => r.kind === 'pane' && r.pane.tmuxId === activePaneId);
    return byActive >= 0 ? byActive : 0;
  }, [rows, selectedKey, activePaneId]);

  const activate = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case 'tab':
          send({ type: 'SELECT_TAB', windowId: row.window.id });
          send({ type: 'BLUR_LEFT_SIDEBAR' });
          return;
        case 'pane':
          // `select-pane` never switches the session's current window, so a
          // pane in another tab is reached by switching the tab first.
          if (row.window.id !== activeWindowId) {
            send({ type: 'SELECT_TAB', windowId: row.window.id });
          }
          // A parked member has no place to focus until it is shown: it
          // takes the slot of the member in view, as its header tab does.
          if (row.parkedBehind) {
            send({
              type: 'DISPATCH_OP',
              op: TmuxOp.GroupSwitch({
                clickedPaneId: row.pane.tmuxId,
                visiblePaneId: row.parkedBehind,
              }),
            });
            return;
          }
          send({ type: 'FOCUS_PANE', paneId: row.pane.tmuxId });
          return;
      }
    },
    [send, activeWindowId],
  );

  const toggleCollapse = useCallback(
    (windowId: WindowId) => send({ type: 'TOGGLE_TAB_COLLAPSE', windowId }),
    [send],
  );

  // join-pane splits the target window's active pane and moves the source
  // there; the source window closes if it was its last pane.
  const movePaneToTab = useCallback(
    (paneId: PaneId, targetWindowId: WindowId) => {
      startMove(paneId, targetWindowId);
      send({ type: 'DISPATCH_OP', op: TmuxOp.JoinPane({ paneId, windowId: targetWindowId }) });
      send({ type: 'SELECT_TAB', windowId: targetWindowId });
    },
    [send, startMove],
  );

  // Capture phase, so it runs before the keyboard actor.
  const stateRef = useRef({ rows, selectedIndex, activate, send, toggleCollapse });
  stateRef.current = { rows, selectedIndex, activate, send, toggleCollapse };
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
      // After the prefix, or in a sticky table (PANE, TAB), a key is a
      // binding's, not the tree's: `prefix p` then `j` moves panes even
      // with the column focused. In a repeat window (`prefix s` then `s`)
      // only the repeated key is; anything else is the tree's again.
      if (bindingOwnsKey(e.key)) return;
      // A key typed into a text box (a tab being renamed, the session
      // switcher's filter) is the box's even while the column holds the keyboard.
      if (isRealFormControl(e.target)) return;
      const target = e.target as HTMLElement | null;
      const {
        rows: rs,
        selectedIndex: idx,
        activate: act,
        send: s,
        toggleCollapse: collapseTab,
      } = stateRef.current;
      if (menuOpenRef.current && e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setMenu(null);
        return;
      }
      const move = (delta: number) => {
        const next = Math.max(0, Math.min(rs.length - 1, idx + delta));
        if (rs[next]) setSelectedKey(rowKey(rs[next]));
      };
      const claim = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      switch (e.key) {
        case 'Tab':
          // With the browser's focus on nothing (the column took the keyboard
          // through a binding) or on a clicked button, Tab is claimed: moving
          // the focus to a header button there meant the next Space "clicked" it.
          if (tabWalksChrome(target)) return;
          claim();
          return;
        case 'j':
        case 'ArrowDown':
          claim();
          move(1);
          return;
        case 'k':
        case 'ArrowUp':
          claim();
          move(-1);
          return;
        case 'Enter':
          claim();
          if (rs[idx]) act(rs[idx]);
          return;
        case 'q':
          // The tree's own key, not a global one: a program pinned in the
          // other sidebar may need every key it gets.
          claim();
          s({ type: 'TOGGLE_LEFT_SIDEBAR' });
          return;
        case 'l':
        case 'ArrowRight': {
          claim();
          const row = rs[idx];
          // Anywhere but a collapsed tab, there is nothing deeper: leave, as nav-right.
          if (row?.kind === 'tab' && row.collapsed) {
            collapseTab(row.window.id);
            return;
          }
          s({ type: 'BLUR_LEFT_SIDEBAR' });
          return;
        }
        case 'h':
        case 'ArrowLeft': {
          claim();
          const row = rs[idx];
          if (row?.kind === 'tab' && !row.collapsed) {
            collapseTab(row.window.id);
            return;
          }
          if (row?.kind === 'pane') {
            setSelectedKey(row.window.id);
            return;
          }
          return;
        }
        default:
          // Plain keys are swallowed, or they would type into the pane behind
          // the column. A chord could be a binding and goes through: swallowing
          // it kept the prefix from the keyboard actor, a keyboard trap.
          if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            e.stopImmediatePropagation();
          }
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focused, bindingOwnsKey]);

  const [renamingWindowId, setRenamingWindowId] = useState<string | null>(null);
  const [dragPaneId, setDragPaneId] = useState<PaneId | null>(null);
  const [dropWindowId, setDropWindowId] = useState<string | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const tabReorder = useReorderDrag({
    containerRef: treeRef,
    cardSelector: '.sidebar-tree-tab[data-window-id]',
    axis: 'y',
    onReorder: (windowId, toIndex) => send({ type: 'REORDER_TAB', windowId, toIndex }),
  });
  // The browser fires a click after a drop's release; it is swallowed once.
  const suppressClickRef = useRef(false);
  const tabCount = windows.length;

  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  // The column takes the keyboard, so the menu's keys don't reach the pane behind it.
  const openMenu = useCallback(
    (state: Exclude<MenuState, null>) => {
      setMenu(state);
      send({ type: 'FOCUS_LEFT_SIDEBAR' });
    },
    [send],
  );

  useLayoutEffect(() => {
    if (!focused) return;
    treeRef.current
      ?.querySelector('.is-selected')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focused, selectedIndex]);

  return (
    <div
      ref={treeRef}
      className="sidebar-tree"
      role="tree"
      aria-label="Tabs and panes"
      aria-activedescendant={
        focused && rows[selectedIndex] ? rowDomId(rowKey(rows[selectedIndex])) : undefined
      }
      data-testid="sidebar-tree"
      data-focused={focused}
    >
      {rows.map((row) => {
        const key = rowKey(row);
        const isSelected = Boolean(rows[selectedIndex] && rowKey(rows[selectedIndex]) === key);
        return (
          <SidebarTreeRow
            key={row.kind === 'tab' ? `w${key}` : `p${key}`}
            row={row}
            isSelected={isSelected}
            activeWindowId={activeWindowId}
            activePaneId={activePaneId}
            tabSummaries={tabSummaries}
            tabCount={tabCount}
            tabReorder={tabReorder}
            suppressClickRef={suppressClickRef}
            renamingWindowId={renamingWindowId}
            setRenamingWindowId={setRenamingWindowId}
            dragPaneId={dragPaneId}
            setDragPaneId={setDragPaneId}
            dropWindowId={dropWindowId}
            setDropWindowId={setDropWindowId}
            cwdByPane={cwdByPane}
            branchOf={branchOf}
            activate={activate}
            toggleCollapse={toggleCollapse}
            movePaneToTab={movePaneToTab}
            openMenu={openMenu}
            send={send}
          />
        );
      })}
      {menu?.kind === 'pane' && (
        <PaneContextMenu paneId={menu.paneId} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
      {menu?.kind === 'tab' && (
        <TabContextMenu
          windowId={menu.windowId}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onRename={() => setRenamingWindowId(menu.windowId)}
        />
      )}
    </div>
  );
});
