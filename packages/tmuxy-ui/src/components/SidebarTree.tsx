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
 * windows filtered out by `selectVisibleWindows`).
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
  selectSessions,
} from '../machines/AppContext';
import { getTabText, getTabIcon } from './paneTabDisplay';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import type { TmuxPane, TmuxWindow } from '../machines/types';

/**
 * A flattened, keyboard-navigable row.
 *
 * With a single session on the socket the tree is just `tab` → `pane` rows.
 * When the `serversActor` poll reports more than one session (web or desktop,
 * whenever the socket hosts several) a `session` level appears: the active
 * session expands to its live `tab`/`pane` rows; every other session expands to
 * read-only `foreign-tab`/`foreign-pane` rows whose activation switches to that
 * session first.
 */
type Row =
  | { kind: 'session'; name: string; active: boolean }
  | { kind: 'tab'; window: TmuxWindow }
  | { kind: 'pane'; pane: TmuxPane; window: TmuxWindow; last: boolean }
  | { kind: 'foreign-tab'; sessionName: string; windowId: string; index: number; name: string }
  | {
      kind: 'foreign-pane';
      sessionName: string;
      windowId: string;
      paneId: string;
      /** App-set title if the pane has one, else its process name. */
      label: string;
      last: boolean;
    };

/**
 * The box-drawing connector a pane row is drawn with. The tree reads as a TUI
 * tree rather than an indented list, so a pane's depth comes from the glyph and
 * every row keeps the same padding.
 */
const connector = (last: boolean) => (last ? '└─ ' : '├─ ');

/** An open right-click menu targeting a tree row, positioned at the cursor. */
type MenuState =
  | { kind: 'pane'; paneId: string; x: number; y: number }
  | { kind: 'tab'; windowIndex: number; x: number; y: number }
  | null;

/** Stable identity per row, used to preserve the keyboard cursor across refreshes. */
function rowKey(r: Row): string {
  switch (r.kind) {
    case 'session':
      return `s:${r.name}`;
    case 'tab':
      return r.window.id;
    case 'pane':
      return r.pane.tmuxId;
    case 'foreign-tab':
      return `ft:${r.sessionName}:${r.windowId}`;
    case 'foreign-pane':
      return `fp:${r.paneId}`;
  }
}

/**
 * Extra indentation under a session header, in steps. Panes are NOT indented
 * past their tab — their connector glyph already reads as the deeper level, and
 * indenting as well would waste a third of a 30-column column.
 */
function rowDepth(r: Row): number {
  switch (r.kind) {
    case 'session':
      return 0;
    case 'tab':
    case 'foreign-tab':
    case 'pane':
    case 'foreign-pane':
      return 1;
  }
}

export const SidebarTree = memo(function SidebarTree({ focused }: { focused: boolean }) {
  const send = useAppSend();
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const panes = useAppSelectorShallow(selectPanes);
  const sessions = useAppSelectorShallow(selectSessions);
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const prefixActive = useAppSelector((ctx) => ctx.prefixActive);

  // Only introduce the session level when the socket actually hosts more than
  // one session; a lone session needs no disambiguating header, so it keeps the
  // classic flat tab→pane tree (the common case on web and desktop alike).
  const grouped = sessions.length > 1;

  // Flatten into the ordered row list (also the keyboard nav order).
  const rows = useMemo<Row[]>(() => {
    // The active session's live subtree (index-ordered tabs, each's panes).
    const liveRows = (): Row[] => {
      const out: Row[] = [];
      for (const window of windows) {
        out.push({ kind: 'tab', window });
        const windowPanes = panes.filter((p) => p.windowId === window.id);
        windowPanes.forEach((pane, i) => {
          out.push({ kind: 'pane', pane, window, last: i === windowPanes.length - 1 });
        });
      }
      return out;
    };

    if (!grouped) return liveRows();

    const out: Row[] = [];
    for (const s of sessions) {
      const isActive = s.sessionName === sessionName;
      out.push({ kind: 'session', name: s.sessionName, active: isActive });
      if (isActive) {
        out.push(...liveRows());
      } else {
        for (const w of s.windows) {
          out.push({
            kind: 'foreign-tab',
            sessionName: s.sessionName,
            windowId: w.id,
            index: w.index,
            name: w.name,
          });
          const sessionPanes = s.panes.filter((p) => p.windowId === w.id);
          sessionPanes.forEach((p, i) => {
            out.push({
              kind: 'foreign-pane',
              sessionName: s.sessionName,
              windowId: w.id,
              paneId: p.id,
              label: p.title || p.command,
              last: i === sessionPanes.length - 1,
            });
          });
        }
      }
    }
    return out;
  }, [grouped, sessions, sessionName, windows, panes]);

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
          send({ type: 'SELECT_TAB', windowId: row.window.id, windowIndex: row.window.index });
          return;
        case 'pane':
          // select-pane targets a pane in any window and switches to it.
          send({ type: 'SEND_TMUX_COMMAND', command: `select-pane -t ${row.pane.tmuxId}` });
          return;
        case 'session':
          if (!row.active) send({ type: 'SWITCH_SESSION', sessionName: row.name });
          return;
        case 'foreign-tab':
        case 'foreign-pane':
          // Not attached to that session yet — switch to it; it lands on its own
          // active window/pane. (Deep-selecting the exact tab/pane after an async
          // session switch is deliberately out of scope.)
          send({ type: 'SWITCH_SESSION', sessionName: row.sessionName });
          return;
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
  // Read inside the capture listener, which is installed once per focus.
  const prefixRef = useRef(prefixActive);
  prefixRef.current = prefixActive;
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
          s({ type: 'BLUR_LEFT_SIDEBAR' });
          return;
        case 'l':
        case 'ArrowRight':
          // Plain l/→ are not tree keys, so they mean the same as nav-right:
          // leave the column. (Ctrl+l takes the binding path below instead.)
          e.preventDefault();
          e.stopImmediatePropagation();
          s({ type: 'BLUR_LEFT_SIDEBAR' });
          return;
        case 'h':
        case 'ArrowLeft':
          // Nothing further left — swallow it rather than let it reach tmux.
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
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
        // Pane depth is drawn by the connector glyph, so only the session level
        // (desktop, multi-session socket) adds real indentation under it.
        const indentStyle = grouped ? { paddingLeft: 10 + rowDepth(row) * 10 } : undefined;

        if (row.kind === 'session') {
          return (
            <div
              key={`s${key}`}
              role="treeitem"
              aria-selected={isSelected}
              className={`sidebar-tree-session${row.active ? ' is-active' : ''}${
                isSelected ? ' is-selected' : ''
              }`}
              style={indentStyle}
              data-session-name={row.name}
              data-testid={`tree-session-${row.name}`}
              onClick={() => activate(row)}
            >
              <span className="sidebar-tree-icon" aria-hidden="true">
                ⬢
              </span>
              <span className="sidebar-tree-label">{row.name}</span>
            </div>
          );
        }

        if (row.kind === 'foreign-tab') {
          return (
            <div
              key={`ft${key}`}
              role="treeitem"
              aria-selected={isSelected}
              className={`sidebar-tree-tab is-foreign${isSelected ? ' is-selected' : ''}`}
              style={indentStyle}
              data-testid={`tree-foreign-tab-${row.windowId}`}
              onClick={() => activate(row)}
            >
              <span className="sidebar-tree-label">
                {row.index}:{row.name || `Tab ${row.index}`}
              </span>
            </div>
          );
        }

        if (row.kind === 'foreign-pane') {
          return (
            <div
              key={`fp${key}`}
              role="treeitem"
              aria-selected={isSelected}
              className={`sidebar-tree-pane is-foreign${isSelected ? ' is-selected' : ''}`}
              style={indentStyle}
              data-testid={`tree-foreign-pane-${row.paneId}`}
              onClick={() => activate(row)}
            >
              <span className="sidebar-tree-branch" aria-hidden="true">
                {connector(row.last)}
              </span>
              <span className="sidebar-tree-label">
                {row.paneId} {row.label}
              </span>
            </div>
          );
        }

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
              style={indentStyle}
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
            style={indentStyle}
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
            <span className="sidebar-tree-branch" aria-hidden="true">
              {connector(row.last)}
            </span>
            {getTabIcon(row.pane) && (
              <span className="sidebar-tree-icon" aria-hidden="true">
                {getTabIcon(row.pane)}
              </span>
            )}
            <span className="sidebar-tree-label">
              {row.pane.tmuxId} {getTabText(row.pane)}
            </span>
            {/* Which pane the keyboard actually goes to, at a glance — the
                green label alone reads the same as the active tab's. */}
            {isActive && (
              <span className="sidebar-tree-active-dot" aria-hidden="true">
                ●
              </span>
            )}
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
