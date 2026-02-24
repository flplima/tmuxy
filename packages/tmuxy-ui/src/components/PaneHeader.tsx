/**
 * PaneHeader - Tab-style pane header with close and add buttons
 *
 * Always shows panes as tabs (even single panes).
 * Pattern: |tab1 x| tab2 x| + |
 * Scrollable when tabs overflow.
 * Right-click shows context menu with pane operations.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAppSend, usePane, usePaneGroup, useCopyModeState } from '../machines/AppContext';
import { PaneContextMenu } from './PaneContextMenu';
import type { TmuxPane } from '../tmux/types';

/**
 * Compute a stable tab title from pane data
 * Uses command > title > tmuxId to avoid blink from borderTitle changes
 */
function getTabTitle(pane: TmuxPane): string {
  if (pane.inMode) {
    return '[COPY]';
  }
  // Show the current command (pane_current_command from tmux)
  if (pane.command) {
    return pane.command;
  }
  // Fallback to pane ID
  return pane.tmuxId;
}

/**
 * Memoized tab component to prevent unnecessary re-renders
 */
/** Minimum pixels of movement before a mousedown becomes a drag */
const DRAG_THRESHOLD = 5;

const PaneTab = memo(function PaneTab({
  pane,
  isSelectedTab,
  isActivePane,
  titleOverride,
  onClick,
  onContextMenu,
  onDragStart,
}: {
  pane: TmuxPane;
  isSelectedTab: boolean;
  isActivePane: boolean;
  titleOverride?: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const tabTitle = titleOverride ?? getTabTitle(pane);
  const pendingDragRef = useRef<{ x: number; y: number; event: React.MouseEvent } | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Record the start position — defer drag until mouse moves past threshold
    pendingDragRef.current = { x: e.clientX, y: e.clientY, event: e };

    const handleMouseMove = (moveEvt: MouseEvent) => {
      if (!pendingDragRef.current) return;
      const dx = Math.abs(moveEvt.clientX - pendingDragRef.current.x);
      const dy = Math.abs(moveEvt.clientY - pendingDragRef.current.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        onDragStart(pendingDragRef.current.event);
        pendingDragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      }
    };

    const handleMouseUp = () => {
      pendingDragRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseDown={handleMouseDown}
      role="tab"
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
    >
      <span className="pane-tab-title">{tabTitle}</span>
    </div>
  );
});

interface PaneHeaderProps {
  paneId: string;
  /** Override the tab title for this pane (used by widgets) */
  titleOverride?: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: string;
}

export function PaneHeader({ paneId, titleOverride }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { groupPanes, activePaneId } = usePaneGroup(paneId);
  const copyState = useCopyModeState(paneId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetPaneId: '',
  });

  // Scroll selected tab into view
  useEffect(() => {
    if (!tabsRef.current || !activePaneId) return;
    const selectedTab = tabsRef.current.querySelector('.pane-tab-selected');
    if (selectedTab) {
      selectedTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activePaneId]);

  const handleContextMenu = useCallback((e: React.MouseEvent, targetPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPaneId,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  if (!pane) return null;

  const { tmuxId, active: isActive, inMode } = pane;

  // Build list of panes to show as tabs
  // If in a group, show all group panes; otherwise just this pane
  const tabPanes = groupPanes && groupPanes.length > 0 ? groupPanes : [pane];
  const activeTabId = activePaneId ?? tmuxId;

  const handleTabClick = (e: React.MouseEvent, clickedPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'TAB_CLICK', paneId: clickedPaneId });
  };

  const handleAddPane = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Add a new pane to this group (or create a group if single pane)
    // Use run-shell directly with format strings (expanded client-side by SEND_TMUX_COMMAND handler)
    // instead of the tmux alias, which resolves #{pane_id} to the control mode pane.
    send({
      type: 'SEND_TMUX_COMMAND',
      command:
        'run-shell "scripts/tmuxy/pane-group-add.sh #{pane_id} #{pane_width} #{pane_height}"',
    });
  };

  const handleTabDragStart = (e: React.MouseEvent, dragPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    send({
      type: 'DRAG_START',
      paneId: dragPaneId,
      startX: e.clientX,
      startY: e.clientY,
    });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    e.preventDefault();
    e.stopPropagation();
    send({ type: 'ZOOM_PANE', paneId: tmuxId });
  };

  const isInCopyMode = inMode || !!copyState;
  const headerClass = `pane-header ${isActive ? 'pane-header-active' : ''} ${isInCopyMode ? 'pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onDoubleClick={handleDoubleClick}
      role="tablist"
      aria-label={`Pane tabs`}
    >
      <div className="pane-tabs" ref={tabsRef}>
        {tabPanes.map((tabPane) => {
          const isSelectedTab = tabPane.tmuxId === activeTabId;
          // Tab is "active" (green) only if this pane is the active tmux pane
          // AND it's the selected tab in the group
          const isActivePane = tabPane.active && isSelectedTab;

          return (
            <PaneTab
              key={tabPane.tmuxId}
              pane={tabPane}
              isSelectedTab={isSelectedTab}
              isActivePane={isActivePane}
              titleOverride={tabPane.tmuxId === paneId ? titleOverride : undefined}
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              onContextMenu={(e) => handleContextMenu(e, tabPane.tmuxId)}
              onDragStart={(e) => handleTabDragStart(e, tabPane.tmuxId)}
            />
          );
        })}
      </div>
      <button
        className="pane-tab-add"
        onClick={handleAddPane}
        title="Add pane to group"
        aria-label="Add new pane to group"
      >
        +
      </button>
      {contextMenu.visible && (
        <PaneContextMenu
          paneId={contextMenu.targetPaneId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
