import { memo, useCallback, useState } from 'react';
import { getTabIcon, getTabText } from './paneTabDisplay';
import { PaneContextMenu } from './PaneContextMenu';
import { TabContextMenu } from './TabContextMenu';
import {
  expandableKey,
  gitContextLabel,
  gitContextTitle,
  rowKey,
  type SidebarTreeRow,
} from './sidebarTreeModel';

type MenuState =
  | { kind: 'pane'; paneId: string; x: number; y: number }
  | { kind: 'tab'; windowIndex: number; x: number; y: number }
  | null;

interface SidebarTreeRowsProps {
  rows: SidebarTreeRow[];
  selectedIndex: number;
  collapsed: ReadonlySet<string>;
  activePaneId: string | null;
  activeWindowId: string | null;
  onSelectKey: (key: string) => void;
  onActivate: (row: SidebarTreeRow) => void;
  onToggleExpanded: (row: SidebarTreeRow) => void;
  onMovePaneToTab: (paneId: string, windowId: string, windowIndex: number) => void;
}

export const SidebarTreeRows = memo(function SidebarTreeRows({
  rows,
  selectedIndex,
  collapsed,
  activePaneId,
  activeWindowId,
  onSelectKey,
  onActivate,
  onToggleExpanded,
  onMovePaneToTab,
}: SidebarTreeRowsProps) {
  const [dragPaneId, setDragPaneId] = useState<string | null>(null);
  const [dropWindowId, setDropWindowId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const twisty = (row: SidebarTreeRow) => {
    const key = expandableKey(row);
    if (!key) return <span className="sidebar-tree-twisty-spacer" aria-hidden="true" />;
    const isCollapsed = collapsed.has(key);
    return (
      <button
        type="button"
        tabIndex={-1}
        className="sidebar-tree-twisty"
        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${rowKey(row)}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleExpanded(row);
        }}
      >
        {isCollapsed ? '▸' : '▾'}
      </button>
    );
  };

  const trailing = (row: SidebarTreeRow) => {
    if (!row.showGitBadge || row.gitContext.kind === 'none') return null;
    return (
      <span className="sidebar-tree-trailing">
        <span
          className={`sidebar-tree-git-badge is-${row.gitContext.kind}`}
          title={gitContextTitle(row.gitContext)}
        >
          <span aria-hidden="true">⑂</span>
          <span className="sidebar-tree-git-label">{gitContextLabel(row.gitContext)}</span>
        </span>
      </span>
    );
  };

  return (
    <>
      {rows.map((row, rowIndex) => {
        const key = rowKey(row);
        const isSelected = rows[selectedIndex] && rowKey(rows[selectedIndex]) === key;
        const indentStyle = { paddingLeft: 8 + row.depth * 16 };
        const expanded = expandableKey(row) ? !collapsed.has(key) : undefined;

        if (row.kind === 'session') {
          return (
            <div
              key={key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={expanded}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={`sidebar-tree-row sidebar-tree-session${
                row.active ? ' is-active' : ''
              }${isSelected ? ' is-selected' : ''}`}
              style={indentStyle}
              data-session-name={row.name}
              data-tree-row-index={rowIndex}
              data-testid={`tree-session-${row.name}`}
              onClick={() => onActivate(row)}
              onFocus={() => onSelectKey(key)}
            >
              {twisty(row)}
              <span
                className={`sidebar-tree-status-dot${row.active ? ' is-active' : ''}`}
                title={row.active ? 'Active session' : 'Session'}
                aria-hidden="true"
              />
              <span className="sidebar-tree-label">{row.name}</span>
              {trailing(row)}
            </div>
          );
        }

        if (row.kind === 'foreign-tab') {
          return (
            <div
              key={key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={expanded}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={`sidebar-tree-row sidebar-tree-tab is-foreign${
                isSelected ? ' is-selected' : ''
              }`}
              style={indentStyle}
              data-tree-row-index={rowIndex}
              data-testid={`tree-foreign-tab-${row.windowId}`}
              onClick={() => onActivate(row)}
              onFocus={() => onSelectKey(key)}
            >
              {twisty(row)}
              <span className="sidebar-tree-icon" aria-hidden="true">
                ▱
              </span>
              <span className="sidebar-tree-label">
                {row.displayIndex}:{row.name || `Window ${row.displayIndex}`}
              </span>
              {trailing(row)}
            </div>
          );
        }

        if (row.kind === 'foreign-pane') {
          const label = row.command || `Pane ${row.paneId}`;
          return (
            <div
              key={key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={`sidebar-tree-row sidebar-tree-pane is-foreign${
                isSelected ? ' is-selected' : ''
              }`}
              style={indentStyle}
              data-tree-row-index={rowIndex}
              title={row.cwd}
              data-testid={`tree-foreign-pane-${row.paneId}`}
              onClick={() => onActivate(row)}
              onFocus={() => onSelectKey(key)}
            >
              {twisty(row)}
              <span className="sidebar-tree-icon" aria-hidden="true">
                ›
              </span>
              <span className="sidebar-tree-label">
                {row.paneId}:{label}
              </span>
              {trailing(row)}
            </div>
          );
        }

        if (row.kind === 'tab') {
          const isActive = row.window.id === activeWindowId;
          const isDropTarget = dropWindowId === row.window.id && dragPaneId !== null;
          return (
            <div
              key={key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={expanded}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              className={`sidebar-tree-row sidebar-tree-tab${isActive ? ' is-active' : ''}${
                isSelected ? ' is-selected' : ''
              }${isDropTarget ? ' is-drop-target' : ''}`}
              style={indentStyle}
              data-window-id={row.window.id}
              data-tree-row-index={rowIndex}
              data-testid={`tree-tab-${row.window.id}`}
              onClick={() => onActivate(row)}
              onFocus={() => onSelectKey(key)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({
                  kind: 'tab',
                  windowIndex: row.window.index,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onDragOver={(event) => {
                if (dragPaneId) {
                  event.preventDefault();
                  setDropWindowId(row.window.id);
                }
              }}
              onDragLeave={() => setDropWindowId((id) => (id === row.window.id ? null : id))}
              onDrop={(event) => {
                event.preventDefault();
                const paneId = event.dataTransfer.getData('text/tmuxy-pane') || dragPaneId;
                if (paneId) onMovePaneToTab(paneId, row.window.id, row.window.index);
                setDragPaneId(null);
                setDropWindowId(null);
              }}
            >
              {twisty(row)}
              <span className="sidebar-tree-icon" aria-hidden="true">
                ▱
              </span>
              <span className="sidebar-tree-label">
                {row.displayIndex}:{row.window.name || `Window ${row.displayIndex}`}
              </span>
              {trailing(row)}
            </div>
          );
        }

        const isActive = row.pane.tmuxId === activePaneId;
        return (
          <div
            key={key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={`sidebar-tree-row sidebar-tree-pane${isActive ? ' is-active' : ''}${
              isSelected ? ' is-selected' : ''
            }${dragPaneId === row.pane.tmuxId ? ' is-dragging' : ''}`}
            style={indentStyle}
            data-pane-id={row.pane.tmuxId}
            data-tree-row-index={rowIndex}
            data-testid={`tree-pane-${row.pane.tmuxId}`}
            draggable
            onClick={() => onActivate(row)}
            onFocus={() => onSelectKey(key)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({
                kind: 'pane',
                paneId: row.pane.tmuxId,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/tmuxy-pane', row.pane.tmuxId);
              event.dataTransfer.effectAllowed = 'move';
              setDragPaneId(row.pane.tmuxId);
            }}
            onDragEnd={() => {
              setDragPaneId(null);
              setDropWindowId(null);
            }}
          >
            {twisty(row)}
            <span className="sidebar-tree-icon" aria-hidden="true">
              {getTabIcon(row.pane) || '›'}
            </span>
            <span className="sidebar-tree-label">{getTabText(row.pane)}</span>
            {trailing(row)}
          </div>
        );
      })}
      {menu?.kind === 'pane' && (
        <PaneContextMenu paneId={menu.paneId} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
      {menu?.kind === 'tab' && (
        <TabContextMenu windowIndex={menu.windowIndex} x={menu.x} y={menu.y} onClose={closeMenu} />
      )}
    </>
  );
});
