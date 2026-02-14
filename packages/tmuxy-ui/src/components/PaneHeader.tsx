/**
 * PaneHeader - Tab-style pane header with close and add buttons
 *
 * Always shows panes as tabs (even single panes).
 * Pattern: |tab1 x| tab2 x| + |
 * Scrollable when tabs overflow.
 * Right-click shows context menu with pane operations.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAppSend, usePane, usePaneGroup } from '../machines/AppContext';
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
  // Show non-shell commands (vim, htop, etc.)
  if (pane.command && !['bash', 'zsh', 'fish', 'sh'].includes(pane.command)) {
    return pane.command;
  }
  // Show title if different from command
  if (pane.title && pane.title !== pane.command) {
    return pane.title;
  }
  // Fallback to pane ID (most stable)
  return pane.tmuxId;
}

/**
 * Memoized tab component to prevent unnecessary re-renders
 */
const PaneTab = memo(function PaneTab({
  pane,
  isSelectedTab,
  isActivePane,
  onClick,
  onContextMenu,
  onClose,
}: {
  pane: TmuxPane;
  isSelectedTab: boolean;
  isActivePane: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const tabTitle = getTabTitle(pane);

  return (
    <div
      className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
    >
      <span className="pane-tab-title">{tabTitle}</span>
      <button
        className="pane-tab-close"
        onClick={onClose}
        title="Close pane"
        aria-label={`Close pane ${pane.tmuxId}`}
      >
        ×
      </button>
    </div>
  );
});

interface PaneHeaderProps {
  paneId: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: string;
}

export function PaneHeader({ paneId }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { group, groupPanes, activePaneId } = usePaneGroup(paneId);
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

  const handleClose = (e: React.MouseEvent, closePaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (group && group.paneIds.length > 1) {
      send({ type: 'PANE_GROUP_CLOSE', groupId: group.id, paneId: closePaneId });
    } else {
      send({ type: 'FOCUS_PANE', paneId: closePaneId });
      send({ type: 'SEND_COMMAND', command: 'kill-pane' });
    }
  };

  const handleTabClick = (e: React.MouseEvent, clickedPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (group && clickedPaneId !== activeTabId) {
      send({ type: 'PANE_GROUP_SWITCH', groupId: group.id, paneId: clickedPaneId });
    } else {
      send({ type: 'FOCUS_PANE', paneId: clickedPaneId });
    }
  };

  const handleAddPane = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Add a new pane to this group (or create a group if single pane)
    send({ type: 'PANE_GROUP_ADD', paneId: tmuxId });
  };

  const handleDragStart = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Don't start drag from buttons
    if (
      target.classList.contains('pane-tab-close') ||
      target.classList.contains('pane-tab-add') ||
      target.tagName === 'BUTTON'
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    send({
      type: 'DRAG_START',
      paneId: tmuxId,
      startX: e.clientX,
      startY: e.clientY,
    });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    e.preventDefault();
    e.stopPropagation();
    send({ type: 'FOCUS_PANE', paneId: tmuxId });
    send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
  };

  const headerClass = `pane-header ${isActive ? 'pane-header-active' : ''} ${inMode ? 'pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onMouseDown={handleDragStart}
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
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              onContextMenu={(e) => handleContextMenu(e, tabPane.tmuxId)}
              onClose={(e) => handleClose(e, tabPane.tmuxId)}
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
