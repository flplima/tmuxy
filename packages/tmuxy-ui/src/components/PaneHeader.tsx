/**
 * PaneHeader - Tab-style pane header with close and add buttons
 *
 * Always shows panes as tabs (even single panes).
 * Pattern: |tab1 x| tab2 x| + |
 * Scrollable when tabs overflow.
 */

import { useRef, useEffect } from 'react';
import { useAppSend, usePane, usePaneGroup } from '../machines/AppContext';

interface PaneHeaderProps {
  paneId: string;
}

export function PaneHeader({ paneId }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { group, groupPanes } = usePaneGroup(paneId);
  const tabsRef = useRef<HTMLDivElement>(null);

  // Scroll selected tab into view
  useEffect(() => {
    if (!tabsRef.current || !group) return;
    const selectedTab = tabsRef.current.querySelector('.pane-tab-selected');
    if (selectedTab) {
      selectedTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [group?.activeIndex]);

  if (!pane) return null;

  const { tmuxId, active: isActive, inMode } = pane;

  // Build list of panes to show as tabs
  // If in a group, show all group panes; otherwise just this pane
  const tabPanes = groupPanes && groupPanes.length > 0 ? groupPanes : [pane];
  const activeTabId = group ? group.paneIds[group.activeIndex] : tmuxId;

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
          const tabTitle = tabPane.inMode
            ? '[COPY]'
            : (tabPane.borderTitle || tabPane.tmuxId);

          return (
            <div
              key={tabPane.tmuxId}
              className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''}`}
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              role="tab"
              aria-selected={isSelectedTab}
              aria-label={`Pane ${tabPane.tmuxId}`}
            >
              <span className="pane-tab-title">{tabTitle}</span>
              <button
                className="pane-tab-close"
                onClick={(e) => handleClose(e, tabPane.tmuxId)}
                title="Close pane"
                aria-label={`Close pane ${tabPane.tmuxId}`}
              >
                ×
              </button>
            </div>
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
    </div>
  );
}
