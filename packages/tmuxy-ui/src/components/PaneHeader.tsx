/**
 * PaneHeader - Minimalistic tab bar for pane groups
 *
 * Always shows panes as tabs (even single panes).
 * Dragging anywhere on the header initiates a pane drag.
 * Right-click shows context menu with pane operations.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAppSend, usePane, usePaneGroup, useCopyModeState } from '../machines/AppContext';
import { PaneContextMenu } from './PaneContextMenu';
import type { TmuxPane } from '../tmux/types';

const PROCESS_ICONS: Record<string, string> = {
  zsh: '\ue6b2', //  nf-seti-shell
  bash: '\ue6b2', //  nf-seti-shell
  fish: '\ue6b2', //  nf-seti-shell
  sh: '\ue6b2', //  nf-seti-shell
  vi: '\ue62b', //  nf-seti-vim
  vim: '\ue62b', //  nf-seti-vim
  nvim: '\ue62b', //  nf-seti-vim
  docker: '\u{f0868}', // 󰡨 nf-md-docker
  node: '\ue718', //  nf-dev-nodejs_small
  python: '\ue73c', //  nf-dev-python
  python3: '\ue73c', //  nf-dev-python
  cargo: '\ue7a8', //  nf-dev-rust
  rustc: '\ue7a8', //  nf-dev-rust
  git: '\ue702', //  nf-dev-git
  ssh: '\uf489', //  nf-oct-terminal
  htop: '\uf080', //  nf-fa-bar_chart
  top: '\uf080', //  nf-fa-bar_chart
  man: '\uf02d', //  nf-fa-book
  less: '\uf02d', //  nf-fa-book
  npm: '\ue71e', //  nf-dev-npm
  make: '\ue779', //  nf-dev-gnu
  gcc: '\ue779', //  nf-dev-gnu
  go: '\ue626', //  nf-seti-go
  lua: '\ue620', //  nf-seti-lua
  ruby: '\ue739', //  nf-dev-ruby
  tmux: '\uf489', //  nf-oct-terminal
};

const WIDGET_ICONS: Record<string, string> = {
  markdown: '\uf48a', //  nf-oct-markdown
  image: '\uf03e', //  nf-fa-image
};

const DEFAULT_ICON = '\uf489'; //  nf-oct-terminal

function getProcessIcon(command: string): string {
  const name = command.toLowerCase();
  if (PROCESS_ICONS[name]) return PROCESS_ICONS[name];
  if (name.includes('docker')) return PROCESS_ICONS.docker;
  return DEFAULT_ICON;
}

/**
 * Compute a stable tab title from pane data
 */
function getTabTitle(pane: TmuxPane, widgetName?: string): string {
  if (pane.inMode) {
    return '[COPY]';
  }
  if (widgetName && WIDGET_ICONS[widgetName]) {
    return `${WIDGET_ICONS[widgetName]} ${pane.title || pane.command || pane.tmuxId}`;
  }
  if (pane.command) {
    return `${getProcessIcon(pane.command)} ${pane.title || pane.command}`;
  }
  return pane.tmuxId;
}

/** Minimum pixels of movement before a mousedown becomes a drag */
const DRAG_THRESHOLD = 5;

const PaneTab = memo(function PaneTab({
  pane,
  isSelectedTab,
  isActivePane,
  titleOverride,
  widgetName,
  onClick,
  onContextMenu,
}: {
  pane: TmuxPane;
  isSelectedTab: boolean;
  isActivePane: boolean;
  titleOverride?: string;
  widgetName?: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const baseTitle = titleOverride ?? getTabTitle(pane, widgetName);
  const tabTitle =
    titleOverride && widgetName && WIDGET_ICONS[widgetName]
      ? `${WIDGET_ICONS[widgetName]} ${titleOverride}`
      : baseTitle;

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
    </div>
  );
});

interface PaneHeaderProps {
  paneId: string;
  /** Override the tab title for this pane (used by widgets) */
  titleOverride?: string;
  /** Widget name for icon lookup (e.g., "markdown", "image") */
  widgetName?: string;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: string;
}

export function PaneHeader({ paneId, titleOverride, widgetName }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { groupPanes, activePaneId } = usePaneGroup(paneId);
  const copyState = useCopyModeState(paneId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pendingDragRef = useRef<{ x: number; y: number } | null>(null);
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
    send({
      type: 'SEND_TMUX_COMMAND',
      command:
        'run-shell "scripts/tmuxy/pane-group-add.sh #{pane_id} #{pane_width} #{pane_height}"',
    });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    e.preventDefault();
    e.stopPropagation();
    send({ type: 'ZOOM_PANE', paneId: tmuxId });
  };

  // Drag from anywhere on the header
  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    pendingDragRef.current = { x: e.clientX, y: e.clientY };

    const startX = e.clientX;
    const startY = e.clientY;

    const handleMouseMove = (moveEvt: MouseEvent) => {
      if (!pendingDragRef.current) return;
      const dx = Math.abs(moveEvt.clientX - pendingDragRef.current.x);
      const dy = Math.abs(moveEvt.clientY - pendingDragRef.current.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        pendingDragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        send({
          type: 'DRAG_START',
          paneId: tmuxId,
          startX,
          startY,
        });
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

  const isInCopyMode = inMode || !!copyState;
  const headerClass = `pane-header ${isActive ? 'pane-header-active' : ''} ${isInCopyMode ? 'pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleHeaderMouseDown}
      role="tablist"
      aria-label={`Pane tabs`}
    >
      <div className="pane-tabs" ref={tabsRef}>
        {tabPanes.map((tabPane) => {
          const isSelectedTab = tabPane.tmuxId === activeTabId;
          const isActivePane = tabPane.active && isSelectedTab;

          return (
            <PaneTab
              key={tabPane.tmuxId}
              pane={tabPane}
              isSelectedTab={isSelectedTab}
              isActivePane={isActivePane}
              titleOverride={tabPane.tmuxId === paneId ? titleOverride : undefined}
              widgetName={tabPane.tmuxId === paneId ? widgetName : undefined}
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              onContextMenu={(e) => handleContextMenu(e, tabPane.tmuxId)}
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
