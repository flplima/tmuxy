/**
 * The attached session's own tabs and panes, never the socket's other
 * sessions: no key in the tree could reach them and no state behind them could
 * draw them. Switching session is the session switcher's (`SessionMenu.tsx`).
 *
 * Escape is never a tree key: a sidebar pane may run a program that needs it.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  useBindingOwnsKey,
} from '../machines/appHooks';
import { selectVisibleWindows } from '../machines/selectors/panesAndSidebars';
import { selectPanes } from '../machines/selectors/layout';
import {
  selectSessions,
  selectRepositories,
  selectPanePorts,
  selectTreeRowTemplate,
} from '../machines/selectors/ui';
import { DEFAULT_ROW_TEMPLATE, parseRowTemplate } from '../domain/rowTemplate';
import { portsByPane } from './panePorts';
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
  fieldsByPane,
  type MenuState,
  type Row,
  type TabGroup,
  buildTreeRows,
  groupByTab,
} from './sidebarTreeRows';
import { SidebarTreeRow } from './SidebarTreeRow';

const NO_TABS: ReadonlySet<WindowId> = new Set();

/**
 * A collapsed tab's group stays mounted, closed to nothing and inert, so the
 * fold animates (styles/sidebar-tree.css).
 */
function TreeTabGroup({
  tab,
  panes,
  renderRow,
}: TabGroup & { renderRow: (row: Row) => ReactNode }) {
  const open = !tab.collapsed;
  return (
    <>
      {renderRow(tab)}
      {panes.length > 0 && (
        <div
          className="sidebar-tree-children"
          role="group"
          data-open={open}
          inert={!open}
          aria-hidden={!open || undefined}
        >
          <div className="sidebar-tree-children-inner">{panes.map(renderRow)}</div>
        </div>
      )}
    </>
  );
}

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const panePorts = useAppSelector(selectPanePorts);
  const treeRowOption = useAppSelector(selectTreeRowTemplate);
  const rowTemplate = useMemo(
    () => parseRowTemplate(treeRowOption) ?? DEFAULT_ROW_TEMPLATE,
    [treeRowOption],
  );
  const collapsedTabIds = useAppSelectorShallow((ctx) => ctx.collapsedTabIds);
  const paneGroups = useAppSelector((ctx) => ctx.paneGroups);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const bindingOwnsKey = useBindingOwnsKey();

  const collapsed = useMemo(() => new Set(collapsedTabIds), [collapsedTabIds]);
  const { cwdByPane, branchOf } = useSidebarGitContext(sessions, sessionName, repositories);
  const portsOf = useMemo(() => portsByPane(panePorts), [panePorts]);
  const fieldsOf = useMemo(() => fieldsByPane(sessions, sessionName), [sessions, sessionName]);

  const tabSummaries = useMemo(
    () =>
      tabPaneStates(
        windows.map((w) => w.id),
        panes,
      ),
    [windows, panes],
  );

  // The keyboard's order: tabs in strip order, each followed by its panes in
  // the order they sit in the grid, so the list follows the layout as it
  // changes (a split, a swap, a move) rather than tmux's creation order.
  const rows = useMemo<Row[]>(
    () => buildTreeRows(windows, panes, collapsed, paneGroups),
    [windows, panes, collapsed, paneGroups],
  );
  // What is drawn: a collapsed tab's panes are folded away rather than left
  // out, so folding and unfolding can be seen.
  const tabGroups = useMemo(
    () => groupByTab(buildTreeRows(windows, panes, NO_TABS, paneGroups), collapsed),
    [windows, panes, collapsed, paneGroups],
  );

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
          // The tab's active pane takes the keyboard, as SELECT_PANE gives it
          // to a pane row's pane.
          send({ type: 'SELECT_TAB', windowId: row.window.id });
          send({ type: 'BLUR_SIDEBAR', side: 'left' });
          return;
        case 'pane':
          // The machine switches the tab, or swaps a parked member in, as a
          // click on the pane or its header tab does.
          send({ type: 'SELECT_PANE', paneId: row.pane.tmuxId });
          return;
      }
    },
    [send],
  );

  const toggleCollapse = useCallback(
    (windowId: WindowId) => send({ type: 'TOGGLE_TAB_COLLAPSE', windowId }),
    [send],
  );

  // join-pane splits the target window's active pane and moves the source
  // there; the source window closes if it was its last pane.
  const movePaneToTab = useCallback(
    (paneId: PaneId, targetWindowId: WindowId) =>
      send({ type: 'MOVE_PANE_TO_TAB', paneId, windowId: targetWindowId }),
    [send],
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
          s({ type: 'TOGGLE_SIDEBAR', side: 'left' });
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
          s({ type: 'BLUR_SIDEBAR', side: 'left' });
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

  const renamingWindowId = useAppSelector((c) =>
    c.renamingTab?.surface === 'tree' ? c.renamingTab.windowId : null,
  );
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
      send({ type: 'FOCUS_SIDEBAR', side: 'left' });
    },
    [send],
  );

  useLayoutEffect(() => {
    if (!focused) return;
    treeRef.current
      ?.querySelector('.is-selected')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focused, selectedIndex]);

  const selectedRowKey = rows[selectedIndex] ? rowKey(rows[selectedIndex]) : null;
  const renderRow = (row: Row) => (
    <SidebarTreeRow
      key={row.kind === 'tab' ? `w${rowKey(row)}` : `p${rowKey(row)}`}
      row={row}
      isSelected={rowKey(row) === selectedRowKey}
      activeWindowId={activeWindowId}
      activePaneId={activePaneId}
      tabSummaries={tabSummaries}
      tabCount={tabCount}
      tabReorder={tabReorder}
      suppressClickRef={suppressClickRef}
      renamingWindowId={renamingWindowId}
      dragPaneId={dragPaneId}
      setDragPaneId={setDragPaneId}
      dropWindowId={dropWindowId}
      setDropWindowId={setDropWindowId}
      cwdByPane={cwdByPane}
      branchOf={branchOf}
      portsOf={portsOf}
      fieldsOf={fieldsOf}
      rowTemplate={rowTemplate}
      activate={activate}
      toggleCollapse={toggleCollapse}
      movePaneToTab={movePaneToTab}
      openMenu={openMenu}
      send={send}
    />
  );

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
      {tabGroups.map(({ tab, panes: tabPanes }) => (
        <TreeTabGroup key={`w${tab.window.id}`} tab={tab} panes={tabPanes} renderRow={renderRow} />
      ))}
      {menu?.kind === 'pane' && (
        <PaneContextMenu paneId={menu.paneId} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
      {menu?.kind === 'tab' && (
        <TabContextMenu
          windowId={menu.windowId}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onRename={() => send({ type: 'RENAME_TAB', windowId: menu.windowId, surface: 'tree' })}
        />
      )}
    </div>
  );
});
