/**
 * SidebarTree — the tab/pane tree the left sidebar shows.
 *
 * Rendered as a tmuxy WIDGET: the left column is a real tmux pane running
 * `tmuxy widget tree`, and this component is what the `tree` widget draws in
 * place of that pane's terminal (see `widgets/TmuxyTree.tsx`). The pane carries
 * no content — the tree is derived purely from the tmuxy state the app already
 * holds (`selectVisibleWindows` + `selectPanes`), with no CLI round-trip or
 * poll. The pane exists to give the column a real pane identity: something
 * `ctrl+hjkl` can navigate into and the backend can size.
 *
 * It reflects the same "tabs" the rest of the UI shows (float/backdrop/sidebar
 * windows filtered out by `selectVisibleWindows`), and ONLY those: the tree is
 * the attached session's own tabs and panes, never the socket's other
 * sessions. Listing them here put rows in the tree that no key in it could
 * reach and no state behind them to draw — switching session is a different
 * question, and it is answered where it is asked, in the session switcher
 * (`SessionMenu.tsx`).
 *
 * Row anatomy, and why it is split across the two edges:
 *  - the LEFT edge answers "where am I?" — a green rail marks the active pane.
 *  - the RIGHT edge answers "what is it doing?" — the pane's own declared state
 *    (`utils/paneState.ts`), with a dead pane's exit status beside it.
 *  - in between, the process name is bold and whatever trails it is dim, so the
 *    eye lands on WHAT is running before WHICH file it has open.
 *  - a tab row carries a chevron and, on its right, the count of panes and the
 *    most attention-worthy state among them — which is the only signal left
 *    once the tab is collapsed.
 *
 * Interactions:
 *  - click a tab → `SELECT_TAB`; click a pane → `select-pane` (tmux switches to
 *    the pane's window too). Clicking a tab's chevron collapses it instead.
 *  - when the sidebar is focused, j/k/↑/↓ move the selection, Enter activates it,
 *    h/← collapses (or steps out to the parent tab), l/→ expands a collapsed tab
 *    and otherwise hands the keyboard back to the panes, and q closes the
 *    column — driven by a capture-phase key listener so the keys never reach the
 *    pane/tmux (the keyboard actor also skips forwarding while focused). Escape
 *    is deliberately NOT a tree key: a sidebar pane may run a program that needs
 *    it, so no sidebar ever claims Escape for itself.
 *  - drag a pane node onto a different tab → `join-pane` moves the pane into that
 *    tab; the tree lists it under the new tab from the drop on.
 *  - drag a tab row up or down → the tabs reorder (`REORDER_TAB`, the strip's
 *    own move, predicted), the same press-and-drag the strip and the overview
 *    take.
 *  - right-click a pane or tab row → the same context menu the pane header /
 *    window tabs show (PaneContextMenu / TabContextMenu).
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { tabPaneStates } from '../utils/paneState';
import { inGridOrder } from '../utils/gridOrder';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import type { PaneId, WindowId } from '../domain/ids';
import { useReorderDrag } from '../hooks/useReorderDrag';
import { tabWalksChrome } from '../utils/chromeTab';
import { isRealFormControl } from '../machines/actors/keyboard/keyFormatting';
import {
  isPlaceholderPane,
  rowDomId,
  rowKey,
  useSidebarGitContext,
  type MenuState,
  type Row,
} from './sidebarTreeRows';
import { SidebarTreeRow } from './SidebarTreeRow';

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const collapsedTabIds = useAppSelectorShallow((ctx) => ctx.collapsedTabIds);
  const unreadPaneIds = useAppSelectorShallow((ctx) => ctx.unreadPaneIds);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const bindingOwnsKey = useBindingOwnsKey();

  const collapsed = useMemo(() => new Set(collapsedTabIds), [collapsedTabIds]);
  const { cwdByPane, branchOf } = useSidebarGitContext(sessions, sessionName, repositories);

  // What each tab rolls up to: how many panes it holds and the most
  // attention-worthy state among them. Collapsed, this is all a tab shows.
  const tabSummaries = useMemo(
    () =>
      tabPaneStates(
        windows.map((w) => w.id),
        panes,
        unreadPaneIds,
      ),
    [windows, panes, unreadPaneIds],
  );

  // Flatten into the ordered row list (also the keyboard nav order): this
  // session's tabs in strip order, each followed by its panes.
  // A pane dropped on another tab is shown under that tab from the drop on,
  // not from tmux's answer on: `join-pane` has no geometry the client could
  // predict for the grid, so the move is held here, for the tree alone, until
  // the pane's window agrees or the pane is gone.
  const [pendingMove, setPendingMove] = useState<{ paneId: PaneId; windowId: WindowId } | null>(
    null,
  );
  useEffect(() => {
    if (!pendingMove) return;
    const pane = panes.find((p) => p.tmuxId === pendingMove.paneId);
    if (!pane || pane.windowId === pendingMove.windowId) setPendingMove(null);
  }, [panes, pendingMove]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const placed = pendingMove
      ? panes.map((p) =>
          p.tmuxId === pendingMove.paneId ? { ...p, windowId: pendingMove.windowId } : p,
        )
      : panes;
    windows.forEach((window, i) => {
      const isCollapsed = collapsed.has(window.id);
      out.push({ kind: 'tab', window, position: i + 1, collapsed: isCollapsed });
      if (isCollapsed) return;
      // In the order they sit in the grid, so the list follows the layout as
      // it changes (a split, a swap, a move) rather than tmux's creation order.
      const windowPanes = inGridOrder(
        placed.filter((p) => p.windowId === window.id && !isPlaceholderPane(p)),
      );
      windowPanes.forEach((pane, i) => {
        out.push({ kind: 'pane', pane, window, last: i === windowPanes.length - 1 });
      });
    });
    return out;
  }, [windows, panes, collapsed, pendingMove]);

  // Keyboard selection cursor, kept on a stable row identity across refreshes.
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
      switch (row.kind) {
        case 'tab':
          // The tab's active pane takes the keyboard, as FOCUS_PANE gives it
          // to a pane row's pane.
          send({ type: 'SELECT_TAB', windowId: row.window.id });
          send({ type: 'BLUR_LEFT_SIDEBAR' });
          return;
        case 'pane':
          // `select-pane` only changes which pane is active WITHIN its window;
          // it never switches the session's current window. So a pane in another
          // tab is reached by switching the tab first, then focusing the pane
          // through the same optimistic path a click on it takes.
          if (row.window.id !== activeWindowId) {
            send({ type: 'SELECT_TAB', windowId: row.window.id });
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

  // Move a pane into another tab: join-pane splits that window's active pane and
  // moves the source there (the source window closes if it was its last pane).
  const movePaneToTab = useCallback(
    (paneId: PaneId, targetWindowId: WindowId) => {
      setPendingMove({ paneId, windowId: targetWindowId });
      send({ type: 'DISPATCH_OP', op: TmuxOp.JoinPane({ paneId, windowId: targetWindowId }) });
      send({ type: 'SELECT_TAB', windowId: targetWindowId });
    },
    [send],
  );

  // Capture-phase keyboard nav while the sidebar is focused (fires before the
  // keyboard actor; stops keys from reaching the pane/tmux).
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
      // A key typed into a text box is the box's — a tab being renamed, the
      // session switcher's filter opened from the column's own title — even
      // while the column holds the keyboard. Claimed here, `q` closed the
      // column and `j` moved the selection instead of reaching the field.
      if (isRealFormControl(e.target)) return;
      const target = e.target as HTMLElement | null;
      const {
        rows: rs,
        selectedIndex: idx,
        activate: act,
        send: s,
        toggleCollapse: collapseTab,
      } = stateRef.current;
      // A context menu opened from a row takes Escape first.
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
          // From the selected row (the tree's one stop), or a control the keyboard reached,
          // Tab moves on like anywhere else on the page. With the browser's
          // focus on nothing (the column took the keyboard through a binding)
          // or on a clicked button, it is claimed: moving the focus to a
          // header button there meant the next Space "clicked" that button.
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
          // Close the column from inside it. This is the tree's own command,
          // not a global key: a program pinned in the other sidebar may need
          // every key it gets, Escape included.
          claim();
          s({ type: 'TOGGLE_LEFT_SIDEBAR' });
          return;
        case 'l':
        case 'ArrowRight': {
          claim();
          const row = rs[idx];
          // On a collapsed tab these open it. Anywhere else there is nothing
          // deeper to go into, so they mean the same as nav-right: leave.
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
          // Close an open tab; from inside one, step out to its tab row first,
          // which is the move every tree makes.
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
          // Not a tree key. Plain keys are swallowed: the tree owns the keyboard
          // while focused, and letting them fall through would type them into
          // the tab's pane behind the column.
          //
          // A chord (ctrl/alt/meta) could be a BINDING and is let through
          // instead. Swallowing those made the column a keyboard trap: the
          // prefix itself could no longer reach the keyboard actor.
          if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            e.stopImmediatePropagation();
          }
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focused, bindingOwnsKey]);

  // Drag state: which pane is being dragged, and which tab is a hover target.
  // The tab whose name is being edited in the tree, if any.
  const [renamingWindowId, setRenamingWindowId] = useState<string | null>(null);
  const [dragPaneId, setDragPaneId] = useState<PaneId | null>(null);
  const [dropWindowId, setDropWindowId] = useState<string | null>(null);

  // A tab row dragged up or down the tree reorders the tabs, the same press
  // and drag the strip and the Tab Overview take, over the tab rows alone:
  // the tree is one column, so only the vertical position decides.
  const treeRef = useRef<HTMLDivElement>(null);
  const tabReorder = useReorderDrag({
    containerRef: treeRef,
    cardSelector: '.sidebar-tree-tab[data-window-id]',
    axis: 'y',
    onReorder: (windowId, toIndex) => send({ type: 'REORDER_TAB', windowId, toIndex }),
  });
  // A drop never doubles as a select: the click the browser fires after the
  // release is swallowed once.
  const suppressClickRef = useRef(false);
  const tabCount = windows.length;

  // Right-click context menu (pane or tab), anchored at the cursor.
  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  // Opening a row's menu also gives the column the keyboard, so Escape (and the
  // menu's own keys) go to the menu rather than to the pane behind the column.
  const openMenu = useCallback(
    (state: Exclude<MenuState, null>) => {
      setMenu(state);
      send({ type: 'FOCUS_LEFT_SIDEBAR' });
    },
    [send],
  );

  // Keep the keyboard cursor in view: a long tree scrolls inside the column,
  // and j/k past the fold used to leave the selection out of sight.
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
            unreadPaneIds={unreadPaneIds}
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
