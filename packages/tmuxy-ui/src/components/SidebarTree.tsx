/**
 * SidebarTree — the tab/pane tree the left sidebar shows.
 *
 * Rendered as a tmuxy WIDGET: the left column is a real tmux pane running
 * `tmuxy widget tree`, and this component is what the `tree` widget draws in
 * place of that pane's terminal (see `widgets/TmuxyTree.tsx`). The pane carries
 * no content — the tree is derived purely from the tmuxy state the app already
 * holds (`selectVisibleWindows` + `selectPanes`), with no CLI round-trip or
 * poll. The pane exists to give the column a real pane identity: something
 * `alt+hjkl` can navigate into and the backend can size.
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
 *    tab (optimistically, via the store).
 *  - right-click a pane or tab row → the same context menu the pane header /
 *    window tabs show (PaneContextMenu / TabContextMenu).
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectVisibleWindows,
  selectPanes,
  selectSessions,
  selectRepositories,
  useReadOnly,
} from '../machines/AppContext';
import { paneRowLines, getTabIcon } from './paneTabDisplay';
import { InlineRename } from './InlineRename';
import {
  findPaneGitContext,
  gitBadgeText,
  summarizeGitContexts,
  type PaneGitContext,
} from './gitContext';
import {
  PANE_STATE_GLYPH,
  PANE_STATE_LABEL,
  aggregatePaneState,
  paneStateFor,
  type PaneStateName,
} from '../utils/paneState';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import type { TmuxPane, TmuxWindow } from '../machines/types';
import { Tooltip } from './Tooltip';

/**
 * A flattened, keyboard-navigable row: the attached session's tabs, each with
 * its panes.
 */
type Row =
  /** `position` is the tab's 1-based place in the strip — the number the tab
   *  strip shows. tmux's own window index has gaps where chrome windows sit,
   *  and printing it here made the two disagree. */
  | { kind: 'tab'; window: TmuxWindow; position: number; collapsed: boolean }
  | { kind: 'pane'; pane: TmuxPane; window: TmuxWindow; last: boolean };

/**
 * The box-drawing connector a pane row is drawn with. The tree reads as a TUI
 * tree rather than an indented list, so a pane's depth comes from the glyph and
 * every row keeps the same padding.
 */
const connector = (last: boolean) => (last ? '└─ ' : '├─ ');

/** An open right-click menu targeting a tree row, positioned at the cursor. */
type MenuState =
  | { kind: 'pane'; paneId: string; x: number; y: number }
  | { kind: 'tab'; windowId: string; x: number; y: number }
  | null;

/** DOM id for a row, so the tree can point `aria-activedescendant` at it. */
const rowDomId = (key: string) => `tree-row-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Nesting depth for `aria-level`: tabs 1, their panes 2. */
function rowLevel(r: Row): number {
  return r.kind === 'tab' ? 1 : 2;
}

/** Optimistic placeholder panes have no identity worth a row; they resolve within a round trip. */
const isPlaceholderPane = (p: TmuxPane) => p.tmuxId.startsWith('__placeholder_');

/** Stable identity per row, used to preserve the keyboard cursor across refreshes. */
function rowKey(r: Row): string {
  return r.kind === 'tab' ? r.window.id : r.pane.tmuxId;
}

/** The state indicator at a row's right edge. `working` is drawn by CSS. */
function StateBadge({ state }: { state: PaneStateName }) {
  const label = PANE_STATE_LABEL[state];
  return (
    <Tooltip label={label}>
      <span className={`sidebar-tree-state is-${state}`} role="img" aria-label={label}>
        {PANE_STATE_GLYPH[state] ?? ''}
      </span>
    </Tooltip>
  );
}

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const readOnly = useReadOnly();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const collapsedTabIds = useAppSelectorShallow((ctx) => ctx.collapsedTabIds);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const prefixActive = useAppSelector((ctx) => ctx.prefixActive);

  const collapsed = useMemo(() => new Set(collapsedTabIds), [collapsedTabIds]);

  // Git context per pane, from the poll's cwds and the discovered worktrees.
  // The poll is the only place a pane's cwd comes from — live state carries
  // none — and it is read for THIS session alone, the one the tree draws.
  const git = useMemo(() => {
    const byPane = new Map<string, PaneGitContext>();
    const panesByWindow = new Map<string, string[]>();
    for (const s of sessions.filter((s) => s.sessionName === sessionName)) {
      for (const p of s.panes) {
        const ids = panesByWindow.get(p.windowId) ?? [];
        ids.push(p.id);
        panesByWindow.set(p.windowId, ids);
        if (repositories.length === 0) continue;
        const context = findPaneGitContext(p.cwd, repositories);
        if (context) byPane.set(p.id, context);
      }
    }
    return { byPane, panesByWindow };
  }, [sessions, sessionName, repositories]);

  const branchOf = useCallback(
    (paneIds: readonly string[]): { text: string; title: string } | null => {
      const summary = summarizeGitContexts(paneIds.map((id) => git.byPane.get(id) ?? null));
      if (summary.kind !== 'single') return null;
      const text = gitBadgeText(summary.context);
      return text ? { text, title: summary.context.worktree.path } : null;
    },
    [git],
  );
  const badgeSpan = (badge: { text: string; title: string } | null) =>
    badge && (
      <Tooltip label={badge.title}>
        <span className="sidebar-tree-git">{badge.text}</span>
      </Tooltip>
    );

  // What each tab rolls up to: how many panes it holds and the most
  // attention-worthy state among them. Collapsed, this is all a tab shows.
  const tabSummaries = useMemo(() => {
    const out = new Map<string, { count: number; state: PaneStateName }>();
    for (const window of windows) {
      const windowPanes = panes.filter((p) => p.windowId === window.id && !isPlaceholderPane(p));
      out.set(window.id, {
        count: windowPanes.length,
        state: aggregatePaneState(windowPanes.map(paneStateFor)),
      });
    }
    return out;
  }, [windows, panes]);

  // Flatten into the ordered row list (also the keyboard nav order): this
  // session's tabs in strip order, each followed by its panes.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    windows.forEach((window, i) => {
      const isCollapsed = collapsed.has(window.id);
      out.push({ kind: 'tab', window, position: i + 1, collapsed: isCollapsed });
      if (isCollapsed) return;
      const windowPanes = panes.filter((p) => p.windowId === window.id && !isPlaceholderPane(p));
      windowPanes.forEach((pane, i) => {
        out.push({ kind: 'pane', pane, window, last: i === windowPanes.length - 1 });
      });
    });
    return out;
  }, [windows, panes, collapsed]);

  // Which pane rows draw a branch. Repeating one worktree down every row of a
  // tab is what made the old tree unreadable, so a pane shows its branch only
  // when it differs from the pane above it in the same tab — the first pane of
  // each tab always shows one, since the tab row itself no longer carries it.
  const branchRows = useMemo(() => {
    const show = new Set<string>();
    let currentWindow: string | null = null;
    let previous: string | null = null;
    for (const row of rows) {
      if (row.kind === 'tab') {
        currentWindow = row.window.id;
        previous = null;
        continue;
      }
      if (row.kind !== 'pane' || row.window.id !== currentWindow) continue;
      const branch = branchOf([row.pane.tmuxId])?.text ?? null;
      if (branch && branch !== previous) show.add(row.pane.tmuxId);
      previous = branch;
    }
    return show;
  }, [rows, branchOf]);

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
          send({ type: 'SELECT_TAB', windowId: row.window.id });
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
    (windowId: string) => send({ type: 'TOGGLE_TAB_COLLAPSE', windowId }),
    [send],
  );

  // Move a pane into another tab: join-pane splits that window's active pane and
  // moves the source there (the source window closes if it was its last pane).
  const movePaneToTab = useCallback(
    (paneId: string, targetWindowId: string) => {
      send({ type: 'SEND_TMUX_COMMAND', command: `join-pane -s ${paneId} -t ${targetWindowId}` });
      send({ type: 'SELECT_TAB', windowId: targetWindowId });
    },
    [send],
  );

  // Capture-phase keyboard nav while the sidebar is focused (fires before the
  // keyboard actor; stops keys from reaching the pane/tmux).
  const stateRef = useRef({ rows, selectedIndex, activate, send, toggleCollapse });
  stateRef.current = { rows, selectedIndex, activate, send, toggleCollapse };
  // Read inside the capture listener, which is installed once per focus.
  const prefixRef = useRef(prefixActive);
  prefixRef.current = prefixActive;
  useEffect(() => {
    if (!focused) return;
    const handler = (e: KeyboardEvent) => {
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
          // The tree owns the keyboard; letting Tab move the browser's focus to
          // a header button meant the next Space "clicked" that button.
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
          // A key that could be a BINDING is let through instead — a chord
          // (ctrl/alt/meta) or the key after the prefix. Swallowing those made
          // the column a keyboard trap: `prefix t`, the very shortcut that
          // opened it, could no longer close it.
          if (!e.ctrlKey && !e.altKey && !e.metaKey && !prefixRef.current) {
            e.stopImmediatePropagation();
          }
          return;
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [focused]);

  // Drag state: which pane is being dragged, and which tab is a hover target.
  // The tab whose name is being edited in the tree, if any.
  const [renamingWindowId, setRenamingWindowId] = useState<string | null>(null);
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [dropWindowId, setDropWindowId] = useState<string | null>(null);

  // Right-click context menu (pane or tab), anchored at the cursor.
  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu !== null;

  // Opening a row's menu also gives the column the keyboard, so Escape (and the
  // menu's own keys) go to the menu rather than to the pane behind the column.
  const openMenu = useCallback(
    (state: Exclude<MenuState, null>) => {
      if (readOnly) return;
      setMenu(state);
      send({ type: 'FOCUS_LEFT_SIDEBAR' });
    },
    [send, readOnly],
  );

  // Keep the keyboard cursor in view: a long tree scrolls inside the column,
  // and j/k past the fold used to leave the selection out of sight.
  const treeRef = useRef<HTMLDivElement>(null);
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
        const isSelected = rows[selectedIndex] && rowKey(rows[selectedIndex]) === key;

        if (row.kind === 'tab') {
          const isActive = row.window.id === activeWindowId;
          const isDropTarget = dropWindowId === row.window.id && dragPaneId !== null;
          const summary = tabSummaries.get(row.window.id);
          const label = row.window.name || `Tab ${row.position}`;
          return (
            <div
              key={`w${key}`}
              role="treeitem"
              id={rowDomId(key)}
              aria-level={rowLevel(row)}
              aria-expanded={!row.collapsed}
              tabIndex={isSelected ? 0 : -1}
              aria-selected={isSelected}
              className={`sidebar-tree-tab${isActive ? ' is-active' : ''}${
                isSelected ? ' is-selected' : ''
              }${isDropTarget ? ' is-drop-target' : ''}${row.collapsed ? ' is-collapsed' : ''}`}
              data-window-id={row.window.id}
              data-collapsed={row.collapsed}
              data-testid={`tree-tab-${row.window.id}`}
              onClick={() => activate(row)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openMenu({
                  kind: 'tab',
                  windowId: row.window.id,
                  x: e.clientX,
                  y: e.clientY,
                });
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
                if (paneId) movePaneToTab(paneId, row.window.id);
                setDragPaneId(null);
                setDropWindowId(null);
              }}
            >
              <button
                type="button"
                className="sidebar-tree-chevron"
                aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${label}`}
                aria-expanded={!row.collapsed}
                data-testid={`tree-chevron-${row.window.id}`}
                onClick={(e) => {
                  // The row itself selects the tab; only the chevron folds it.
                  e.stopPropagation();
                  toggleCollapse(row.window.id);
                }}
              >
                {row.collapsed ? '▸' : '▾'}
              </button>
              {renamingWindowId === row.window.id ? (
                <InlineRename
                  value={row.window.name}
                  ariaLabel={`Rename tab ${row.position}`}
                  onCommit={(name) => {
                    setRenamingWindowId(null);
                    send({
                      type: 'SEND_TMUX_COMMAND',
                      command: `rename-window -t ${row.window.id} -- ${JSON.stringify(name)}`,
                    });
                  }}
                  onCancel={() => setRenamingWindowId(null)}
                />
              ) : (
                <span className="sidebar-tree-label">
                  <span className="sidebar-tree-name">
                    {row.position}:{label}
                  </span>
                </span>
              )}
              {summary && summary.count > 0 && (
                <span className="sidebar-tree-count" aria-hidden="true">
                  {summary.count}
                </span>
              )}
              {summary && <StateBadge state={summary.state} />}
            </div>
          );
        }

        const isActive = row.pane.tmuxId === activePaneId;
        const { process, title } = paneRowLines(row.pane);
        const icon = getTabIcon(row.pane);
        const state = paneStateFor(row.pane);
        return (
          <div
            key={`p${key}`}
            role="treeitem"
            id={rowDomId(key)}
            aria-level={rowLevel(row)}
            tabIndex={isSelected ? 0 : -1}
            aria-selected={isSelected}
            className={`sidebar-tree-pane${isActive ? ' is-active' : ''}${
              isSelected ? ' is-selected' : ''
            }${dragPaneId === row.pane.tmuxId ? ' is-dragging' : ''}`}
            data-pane-id={row.pane.tmuxId}
            data-pane-state={state}
            data-testid={`tree-pane-${row.pane.tmuxId}`}
            draggable={!readOnly}
            onClick={() => activate(row)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu({ kind: 'pane', paneId: row.pane.tmuxId, x: e.clientX, y: e.clientY });
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
            {/* Where the keyboard is. The left edge answers that; the right
                edge answers what the pane is doing. */}
            <span className="sidebar-tree-rail" aria-hidden="true" />
            <span className="sidebar-tree-branch" aria-hidden="true">
              {connector(row.last)}
            </span>
            {row.pane.marked && (
              <Tooltip label="Marked pane">
                <span className="sidebar-tree-mark" aria-label="Marked pane">
                  ⚑
                </span>
              </Tooltip>
            )}
            {icon && (
              <span className="sidebar-tree-icon" aria-hidden="true">
                {icon}
              </span>
            )}
            {/* Two lines: what the pane IS on the first, what it is SHOWING on
                the second. The id leads the first line, dim — it is what tells
                two panes running the same program apart, the common case (two
                shells in a tab) — and the state indicator closes it. The title
                gets its own line because it is the half that routinely outgrows
                a 30-column column; a pane with nothing to add draws one line. */}
            <span className="sidebar-tree-label">
              <span className="sidebar-tree-line">
                <span className="sidebar-tree-id">{row.pane.tmuxId}</span>{' '}
                <span className="sidebar-tree-name">{process}</span>
              </span>
              {title && <span className="sidebar-tree-title">{title}</span>}
            </span>
            {branchRows.has(row.pane.tmuxId) && badgeSpan(branchOf([row.pane.tmuxId]))}
            <StateBadge state={state} />
          </div>
        );
      })}
      {/* The tree's commands, shown only while it has the keyboard — an idle
          column listing keys it doesn't currently take would be noise. */}
      {focused && (
        <div className="sidebar-tree-hint" aria-hidden="true">
          <span>j/k move</span>
          <span>⏎ open</span>
          <span>h/l fold</span>
          <span>q close</span>
        </div>
      )}
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
