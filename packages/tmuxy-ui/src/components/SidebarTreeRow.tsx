/**
 * SidebarTreeRow — row types, git context helpers, and tab/pane treeitem rows
 * for SidebarTree.
 */

import { TmuxOp } from '../domain/commands';
import { paneRowLines, getTabIcon, tabIcon } from './paneTabDisplay';
import { InlineRename } from './InlineRename';
import { PaneStateMark } from './PaneStateMark';
import { paneStateFor, type tabPaneStates } from '../utils/paneState';
import { Tooltip } from './Tooltip';
import { isModelPaneId, type PaneId, type WindowId } from '../domain/ids';
import type { useReorderDrag } from '../hooks/useReorderDrag';
import type { AppMachineEvent } from '../machines/types/events';
import { Row, MenuState, rowDomId, rowKey } from './sidebarTreeRows';

/** Nesting depth for `aria-level`: tabs 1, their panes 2. */
function rowLevel(r: Row): number {
  return r.kind === 'tab' ? 1 : 2;
}

/** A pane's cwd as its row shows it: with the trailing slash of a directory. */
function displayCwd(cwd: string | undefined): string {
  if (!cwd) return '';
  return cwd.endsWith('/') ? cwd : `${cwd}/`;
}

// The branch's slot is held even outside a repository, so every row's path
// gets the same width and the columns line up down the tree.
const badgeSpan = (badge: { text: string; title: string } | null) =>
  badge ? (
    <Tooltip label={badge.title}>
      <span className="sidebar-tree-git">{badge.text}</span>
    </Tooltip>
  ) : (
    <span className="sidebar-tree-git is-empty" aria-hidden="true" />
  );

interface SidebarTreeRowProps {
  row: Row;
  isSelected: boolean;
  readOnly: boolean;
  activeWindowId: WindowId | null;
  activePaneId: PaneId | null;
  unreadPaneIds: readonly PaneId[];
  tabSummaries: ReturnType<typeof tabPaneStates>;
  tabCount: number;
  tabReorder: ReturnType<typeof useReorderDrag>;
  suppressClickRef: React.MutableRefObject<boolean>;
  renamingWindowId: string | null;
  setRenamingWindowId: React.Dispatch<React.SetStateAction<string | null>>;
  dragPaneId: PaneId | null;
  setDragPaneId: React.Dispatch<React.SetStateAction<PaneId | null>>;
  dropWindowId: string | null;
  setDropWindowId: React.Dispatch<React.SetStateAction<string | null>>;
  cwdByPane: Map<PaneId, string>;
  branchOf: (paneIds: readonly PaneId[]) => { text: string; title: string } | null;
  activate: (row: Row) => void;
  toggleCollapse: (windowId: WindowId) => void;
  movePaneToTab: (paneId: PaneId, targetWindowId: WindowId) => void;
  openMenu: (state: Exclude<MenuState, null>) => void;
  send: (event: AppMachineEvent) => void;
}

export function SidebarTreeRow({
  row,
  isSelected,
  readOnly,
  activeWindowId,
  activePaneId,
  unreadPaneIds,
  tabSummaries,
  tabCount,
  tabReorder,
  suppressClickRef,
  renamingWindowId,
  setRenamingWindowId,
  dragPaneId,
  setDragPaneId,
  dropWindowId,
  setDropWindowId,
  cwdByPane,
  branchOf,
  activate,
  toggleCollapse,
  movePaneToTab,
  openMenu,
  send,
}: SidebarTreeRowProps) {
  const key = rowKey(row);

  if (row.kind === 'tab') {
    const isActive = row.window.id === activeWindowId;
    const isDropTarget = dropWindowId === row.window.id && dragPaneId !== null;
    const summary = tabSummaries.get(row.window.id);
    const { icon: tabMark, label } = tabIcon(row.window.name, row.position);
    const tabState = !summary || summary.state === 'working' ? 'idle' : summary.state;
    const tabIndex = row.position - 1;
    const isDragged = tabReorder.dragging?.windowId === row.window.id;
    const dropBefore = tabReorder.dropMarkerAt === tabIndex;
    const dropAfter = tabReorder.dropMarkerAt === tabCount && tabIndex === tabCount - 1;
    return (
      <div
        role="treeitem"
        id={rowDomId(key)}
        aria-level={rowLevel(row)}
        aria-expanded={!row.collapsed}
        tabIndex={isSelected ? 0 : -1}
        aria-selected={isSelected}
        className={`sidebar-tree-tab${isActive ? ' is-active' : ''}${
          isSelected ? ' is-selected' : ''
        }${isDropTarget ? ' is-drop-target' : ''}${row.collapsed ? ' is-collapsed' : ''}${
          isDragged ? ' is-dragging' : ''
        }${dropBefore ? ' is-drop-before' : ''}${dropAfter ? ' is-drop-after' : ''}`}
        style={isDragged ? { transform: `translateY(${tabReorder.dragging!.dy}px)` } : undefined}
        data-window-id={row.window.id}
        data-collapsed={row.collapsed}
        data-testid={`tree-tab-${row.window.id}`}
        onPointerDown={(e) => {
          // The chevron folds, the field renames, a right-click menus:
          // none of them starts a drag.
          if (readOnly || e.button !== 0 || renamingWindowId === row.window.id) return;
          if ((e.target as HTMLElement).closest('button')) return;
          tabReorder.handlePointerDown(e, row.window.id, tabIndex);
        }}
        onPointerMove={tabReorder.handlePointerMove}
        onPointerUp={(e) => {
          if (tabReorder.handlePointerUp(e)?.active) suppressClickRef.current = true;
        }}
        onPointerCancel={tabReorder.handlePointerCancel}
        onClick={(e) => {
          // A row picks a target; the click must not go on to the column,
          // which would take the keyboard back from it.
          e.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          activate(row);
        }}
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
          const dropped = e.dataTransfer.getData('text/tmuxy-pane');
          const paneId = isModelPaneId(dropped) ? dropped : dragPaneId;
          if (paneId) movePaneToTab(paneId, row.window.id);
          setDragPaneId(null);
          setDropWindowId(null);
        }}
      >
        <button
          type="button"
          className="sidebar-tree-chevron"
          // A pointer target; the keyboard folds a tab with l/h.
          tabIndex={-1}
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
                type: 'DISPATCH_OP',
                op: TmuxOp.RenameWindow({ target: row.window.id, name }),
              });
            }}
            onCancel={() => setRenamingWindowId(null)}
          />
        ) : (
          <span className="sidebar-tree-label">
            <span className="sidebar-tree-name">
              {/* The tab strip's icon — or, in its place, what wants the
                  user. Work in progress shows on the pane rows, not twice. */}
              {tabState === 'idle' ? (
                <span className="sidebar-tree-tab-icon" aria-hidden="true">
                  {tabMark}
                </span>
              ) : (
                <PaneStateMark
                  state={tabState}
                  className="sidebar-tree-tab-icon sidebar-tree-state"
                />
              )}
              {label}
            </span>
          </span>
        )}
        {row.collapsed && summary && summary.count > 0 && (
          <span className="sidebar-tree-count" aria-hidden="true">
            {summary.count}
          </span>
        )}
      </div>
    );
  }

  const isActive = row.pane.tmuxId === activePaneId;
  // The current tab's panes read a step brighter than the dimmed rest.
  const inCurrentTab = row.window.id === activeWindowId;
  const { process, title } = paneRowLines(row.pane);
  const icon = getTabIcon(row.pane);
  const state = paneStateFor(row.pane, unreadPaneIds.includes(row.pane.tmuxId));
  const cwd = displayCwd(cwdByPane.get(row.pane.tmuxId));
  const branch = branchOf([row.pane.tmuxId]);
  return (
    <div
      role="treeitem"
      id={rowDomId(key)}
      aria-level={rowLevel(row)}
      tabIndex={isSelected ? 0 : -1}
      aria-selected={isSelected}
      className={`sidebar-tree-pane${isActive ? ' is-active' : ''}${
        inCurrentTab ? ' in-current-tab' : ''
      }${isSelected ? ' is-selected' : ''}${dragPaneId === row.pane.tmuxId ? ' is-dragging' : ''}`}
      data-pane-id={row.pane.tmuxId}
      data-pane-state={state}
      data-testid={`tree-pane-${row.pane.tmuxId}`}
      draggable={!readOnly}
      onClick={(e) => {
        e.stopPropagation();
        activate(row);
      }}
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
      <span className={`sidebar-tree-branch${row.last ? ' is-last' : ''}`} aria-hidden="true" />
      {/* Up to three lines. What the pane IS: its icon (or, in its place,
          what it is doing — as on its header), the process, and its id on
          the right. WHERE it is: the cwd, cut from the left so the end of
          the path survives, and the branch. What it is SHOWING: the
          program's own title, with the whole width to itself — an agent's
          runs long. */}
      <span className="sidebar-tree-label">
        <span className="sidebar-tree-line">
          {row.pane.marked && (
            <Tooltip label="Marked pane">
              <span className="sidebar-tree-mark" aria-label="Marked pane">
                ⚑
              </span>
            </Tooltip>
          )}
          {state !== 'idle' ? (
            <PaneStateMark state={state} className="sidebar-tree-icon sidebar-tree-state" />
          ) : (
            icon && (
              <span className="sidebar-tree-icon" aria-hidden="true">
                {icon}
              </span>
            )
          )}
          <span className="sidebar-tree-name">{process}</span>
          <span className="sidebar-tree-id">{row.pane.tmuxId}</span>
        </span>
        {(cwd || branch) && (
          <span className="sidebar-tree-where">
            <span className="sidebar-tree-cwd">{cwd && `\u200e${cwd}\u200e`}</span>
            {badgeSpan(branch)}
          </span>
        )}
        {title && <span className="sidebar-tree-title">{title}</span>}
      </span>
    </div>
  );
}
