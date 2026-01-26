/**
 * PaneHeader - Draggable pane header with title and close button
 *
 * Shows the tmux pane title left-aligned, with close button on right.
 */

import { useAppSend, usePane, usePaneGroup } from '../machines/AppContext';

interface PaneHeaderProps {
  paneId: string;
}

export function PaneHeader({ paneId }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { group, groupPanes } = usePaneGroup(paneId);

  if (!pane) return null;

  const { tmuxId, borderTitle, active: isActive, inMode } = pane;
  const displayTitle = inMode ? '[COPY MODE]' : (borderTitle || tmuxId);

  const handleClose = (e: React.MouseEvent, closePaneId: string = tmuxId) => {
    e.preventDefault();
    e.stopPropagation();
    if (group && group.paneIds.length > 1) {
      send({ type: 'GROUP_CLOSE_PANE', groupId: group.id, paneId: closePaneId });
    } else {
      send({ type: 'FOCUS_PANE', paneId: closePaneId });
      send({ type: 'SEND_COMMAND', command: 'kill-pane' });
    }
  };

  const handleSwitchTab = (e: React.MouseEvent, switchPaneId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (group) {
      send({ type: 'GROUP_SWITCH', groupId: group.id, paneId: switchPaneId });
    }
  };

  const handleDragStart = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.classList.contains('pane-close') ||
      target.classList.contains('group-tab') ||
      target.classList.contains('group-tab-close') ||
      target.closest('.group-tab')
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
    // Don't toggle zoom when clicking close button or tabs
    if (
      target.classList.contains('pane-close') ||
      target.classList.contains('group-tab') ||
      target.classList.contains('group-tab-close') ||
      target.closest('.group-tab')
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    // Focus the pane first, then toggle zoom
    send({ type: 'FOCUS_PANE', paneId: tmuxId });
    send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
  };

  // Grouped panes - show tabs
  const isGrouped = group && group.paneIds.length > 1;

  if (isGrouped && groupPanes) {
    const groupedHeaderClass = `pane-header pane-header-grouped ${isActive ? 'pane-header-active' : ''} ${inMode ? 'pane-header-copy-mode' : ''}`;
    return (
      <div
        className={groupedHeaderClass}
        onMouseDown={handleDragStart}
        onDoubleClick={handleDoubleClick}
        role="tablist"
        aria-label={`Group with ${groupPanes.length} panes`}
      >
        <div className="group-tabs">
          {groupPanes.map((groupPane) => {
            const isActiveTab = group.paneIds[group.activeIndex] === groupPane.tmuxId;
            const tabTitle = groupPane.inMode ? '[COPY MODE]' : (groupPane.borderTitle || groupPane.tmuxId);
            return (
              <div
                key={groupPane.tmuxId}
                className={`group-tab ${isActiveTab ? 'group-tab-active' : ''}`}
                onClick={(e) => handleSwitchTab(e, groupPane.tmuxId)}
                role="tab"
                aria-selected={isActiveTab}
                aria-label={`Pane ${groupPane.tmuxId}: ${groupPane.title}`}
              >
                <span className="group-tab-title">{tabTitle}</span>
                <button
                  className="group-tab-close"
                  onClick={(e) => handleClose(e, groupPane.tmuxId)}
                  title="Close tab"
                  aria-label={`Close pane ${groupPane.tmuxId}`}
                >
                  &times;
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Regular pane header - centered title with close button on right
  const headerClass = `pane-header ${isActive ? 'pane-header-active' : ''} ${inMode ? 'pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onMouseDown={handleDragStart}
      onDoubleClick={handleDoubleClick}
      role="toolbar"
      aria-label={`Pane ${tmuxId} toolbar`}
    >
      <span className="pane-title">{displayTitle}</span>
      <button
        className="pane-close"
        onClick={(e) => handleClose(e)}
        title="Close pane"
        aria-label={`Close pane ${tmuxId}`}
      >
        &times;
      </button>
    </div>
  );
}
