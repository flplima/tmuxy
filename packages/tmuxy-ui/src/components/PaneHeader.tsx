/**
 * PaneHeader - Minimalistic tab bar for pane groups
 *
 * Always shows panes as tabs (even single panes).
 * Dragging anywhere on the header initiates a pane drag.
 * Right-click shows context menu with pane operations.
 */

import { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAppSend, usePane, usePaneGroup } from '../machines/AppContext';
import { PaneContextMenu } from './PaneContextMenu';
import { getTabIcon, getTabText } from './paneTabDisplay';
import type { TmuxPane } from '../tmux/types';

/** Minimum pixels of movement before a mousedown becomes a drag */
const DRAG_THRESHOLD = 5;

/** Long-press duration in ms to initiate drag on touch devices */
const LONG_PRESS_MS = 400;

/** Maximum touch movement in px before cancelling long-press */
const LONG_PRESS_MOVE_THRESHOLD = 10;

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
  const icon = getTabIcon(pane, widgetName);
  const text = getTabText(pane, titleOverride, widgetName);

  return (
    <div
      className={`pane-tab ${isActivePane ? 'pane-tab-active' : ''} ${isSelectedTab ? 'pane-tab-selected' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isSelectedTab}
      aria-label={`Pane ${pane.tmuxId}`}
    >
      {icon && <span className="pane-tab-icon pane-tab-icon-static">{icon}</span>}
      <span className="pane-tab-title">{text}</span>
    </div>
  );
});

interface PaneHeaderProps {
  paneId: string;
  /** Override the tab title for this pane (used by widgets) */
  titleOverride?: string;
  /** Widget name for icon lookup (e.g., "markdown", "image") */
  widgetName?: string;
  /** Float pane mode: hides group add button, wires close to onFloatClose */
  isFloat?: boolean;
  /** Called when the close button is clicked in float mode */
  onFloatClose?: () => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: string;
}

export function PaneHeader({
  paneId,
  titleOverride,
  widgetName,
  isFloat,
  onFloatClose,
}: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { groupPanes, activePaneId } = usePaneGroup(paneId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pendingDragRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetPaneId: '',
  });

  // Cleanup long-press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

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

  const handleMenuClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const targetId = activePaneId ?? paneId;
      setContextMenu({
        visible: true,
        x: rect.left,
        y: rect.bottom + 2,
        targetPaneId: targetId,
      });
    },
    [activePaneId, paneId],
  );

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
    send({ type: 'SELECT_PANE_GROUP_TAB', paneId: clickedPaneId });
  };

  const handleClosePane = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Uses CLOSE_PANE which routes through pane-group-close.sh
    // to handle both grouped and ungrouped panes correctly.
    const targetId = activePaneId ?? tmuxId;
    send({ type: 'CLOSE_PANE', paneId: targetId });
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
        const containerEl = (moveEvt.target as HTMLElement).closest('.pane-layout');
        const containerRect = containerEl?.getBoundingClientRect();
        send({
          type: 'DRAG_START',
          paneId: tmuxId,
          startX,
          startY,
          containerLeft: containerRect?.left ?? 0,
          containerTop: containerRect?.top ?? 0,
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

  // Long-press touch to initiate drag on mobile
  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;
    touchStartRef.current = { x: startX, y: startY };

    // Capture DOM refs eagerly — React synthetic event is recycled after this handler returns
    const headerEl = e.currentTarget as HTMLElement;

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      touchStartRef.current = null;

      const containerEl = headerEl.closest('.pane-layout');
      const containerRect = containerEl?.getBoundingClientRect();
      send({
        type: 'DRAG_START',
        paneId: tmuxId,
        startX,
        startY,
        containerLeft: containerRect?.left ?? 0,
        containerTop: containerRect?.top ?? 0,
      });
    }, LONG_PRESS_MS);

    const handleTouchMove = (moveEvt: TouchEvent) => {
      if (!touchStartRef.current) {
        // Drag already started — let pointerTracker handle it
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
        return;
      }
      const t = moveEvt.touches[0];
      const dx = Math.abs(t.clientX - touchStartRef.current.x);
      const dy = Math.abs(t.clientY - touchStartRef.current.y);
      if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
        // Finger moved too much — cancel long-press (user is scrolling)
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        touchStartRef.current = null;
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
      }
    };

    const handleTouchEnd = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      touchStartRef.current = null;
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
  };

  const headerClass = `pane-header ${isActive ? 'pane-header-active' : ''} ${inMode ? 'pane-header-copy-mode' : ''}`;

  return (
    <div
      className={headerClass}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleHeaderMouseDown}
      onTouchStart={handleHeaderTouchStart}
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
        className="pane-header-menu"
        onClick={handleMenuClick}
        title="Pane menu"
        aria-label="Pane menu"
      >
        ⋮
      </button>
      <button
        className="pane-header-close"
        onClick={(e) => {
          e.stopPropagation();
          if (isFloat) onFloatClose?.();
          else handleClosePane(e);
        }}
        title="Close pane"
        aria-label="Close pane"
      >
        ✕
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
