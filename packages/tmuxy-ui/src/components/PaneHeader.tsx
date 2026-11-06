import { useRef, useEffect, useState, useCallback } from 'react';
import { TmuxOp } from '../domain/commands';
import { selectDraggedPaneId, selectGroupDrop } from '../machines/selectors/layout';
import { useAppSelector, useAppSend, usePane, usePaneGroup } from '../machines/appHooks';
import { PaneContextMenu } from './PaneContextMenu';
import { PaneTab } from './PaneTab';
import { Tooltip } from './Tooltip';
import { selectKeyBindings } from '../machines/selectors/ui';
import { keyHint } from '../domain/keyLabels';
import type { KeyBindings } from '../domain/wire';
import { measureTabStrip } from '../machines/drag/tabStripDrop';
import { DRAG_THRESHOLD_PX, LONG_PRESS_MS } from '../domain/tabOverview';
import { isModelPaneId, type PaneId } from '../domain/ids';

/** px a finger may move before a long-press is taken for a scroll. */
const LONG_PRESS_MOVE_THRESHOLD = 10;

interface PaneHeaderProps {
  paneId: PaneId;
  titleOverride?: string;
  /** In a float, ✕ calls onFloatClose. */
  isFloat?: boolean;
  onFloatClose?: () => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPaneId: PaneId | null;
}

function markedTooltip(keybindings: KeyBindings | null): string {
  const mark = keyHint(keybindings, TmuxOp.MarkPane({ marked: true }));
  const clear = keyHint(keybindings, TmuxOp.MarkPane({ marked: false }));
  const keys = [mark && `${mark} marks`, clear && `${clear} clears`].filter(Boolean).join(', ');
  return keys ? `Marked pane — ${keys}` : 'Marked pane';
}

export function PaneHeader({ paneId, titleOverride, isFloat, onFloatClose }: PaneHeaderProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const { groupPanes, activePaneId } = usePaneGroup(paneId);
  const groupDrop = useAppSelector(selectGroupDrop);
  const draggedPaneId = useAppSelector(selectDraggedPaneId);
  const tabsRef = useRef<HTMLDivElement>(null);
  const pendingDragRef = useRef<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  // Opened from this header's menu or the pane content's: whichever header
  // draws that pane shows the field.
  const renamingPaneId = useAppSelector((c) => c.renamingPaneId);
  const keybindings = useAppSelector(selectKeyBindings);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetPaneId: null,
  });

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!tabsRef.current || !activePaneId) return;
    const selectedTab = tabsRef.current.querySelector('.pane-tab-selected');
    if (selectedTab) {
      selectedTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activePaneId]);

  const handleContextMenu = useCallback((e: React.MouseEvent, targetPaneId: PaneId) => {
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
    (e: React.MouseEvent, forPaneId?: PaneId) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const targetId = forPaneId ?? activePaneId ?? paneId;
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
  const isGroup = tabPanes.length > 1;
  const activeTabId = activePaneId ?? tmuxId;
  // A group shows one member at a time; "marked" belongs to that one.
  const shownPane = tabPanes.find((p) => p.tmuxId === activeTabId) ?? pane;

  const handleTabClick = (e: React.MouseEvent, clickedPaneId: PaneId) => {
    e.preventDefault();
    e.stopPropagation();
    // FOCUS_PANE on a parked group member would fire a premature `select-pane`
    // into the stash window, racing swap-pane.
    if (isGroup) {
      send({ type: 'SELECT_PANE_GROUP_TAB', paneId: clickedPaneId });
    } else {
      send({ type: 'FOCUS_PANE', paneId: clickedPaneId });
    }
  };

  const handleClosePane = (e: React.MouseEvent, forPaneId?: PaneId) => {
    e.preventDefault();
    e.stopPropagation();
    // CLOSE_PANE goes through `pane-group close`, which can close a parked member.
    const targetId = forPaneId ?? activePaneId ?? tmuxId;
    send({ type: 'CLOSE_PANE', paneId: targetId });
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    e.preventDefault();
    e.stopPropagation();
    send({ type: 'ZOOM_PANE', paneId: tmuxId });
  };

  const memberUnder = (el: HTMLElement): PaneId => {
    const tab = isGroup ? el.closest<HTMLElement>('.pane-tab')?.dataset.paneTab : undefined;
    return isModelPaneId(tab) ? tab : tmuxId;
  };

  const dropMarkFor = (index: number): 'onto' | 'before' | 'after' | null => {
    if (!groupDrop) return null;
    if (groupDrop.kind === 'order') {
      if (!tabPanes.some((p) => p.tmuxId === groupDrop.paneId)) return null;
      return index === groupDrop.index && index !== groupDrop.from ? 'onto' : null;
    }
    if (groupDrop.anchorPaneId !== tmuxId) return null;
    if (index === groupDrop.index) return 'before';
    return index === tabPanes.length - 1 && groupDrop.index === tabPanes.length ? 'after' : null;
  };

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    // Pressing a pane's title bar takes the pane, as pressing its body does, so
    // moving or renaming it needs no click inside. A group's tabs keep their own handler.
    if (!target.closest('.pane-tab')) {
      send({ type: 'FOCUS_PANE', paneId: tmuxId });
    }

    pendingDragRef.current = { x: e.clientX, y: e.clientY };
    // A group's tab drags the member it names, parked or not.
    const dragId = memberUnder(target);

    const startX = e.clientX;
    const startY = e.clientY;

    const handleMouseMove = (moveEvt: MouseEvent) => {
      if (!pendingDragRef.current) return;
      const dx = Math.abs(moveEvt.clientX - pendingDragRef.current.x);
      const dy = Math.abs(moveEvt.clientY - pendingDragRef.current.y);
      if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
        pendingDragRef.current = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        const containerEl = (moveEvt.target as HTMLElement).closest('.pane-layout');
        const containerRect = containerEl?.getBoundingClientRect();
        send({
          type: 'DRAG_START',
          paneId: dragId,
          startX,
          startY,
          containerLeft: containerRect?.left ?? 0,
          containerTop: containerRect?.top ?? 0,
          // Measured once, here: the strip cannot reflow during a drag, and
          // the machine's pointer listeners give it no element to ask.
          tabStrip: measureTabStrip(),
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

  const handleHeaderTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'BUTTON') return;

    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;
    touchStartRef.current = { x: startX, y: startY };

    // `currentTarget` is null once the handler returns.
    const headerEl = e.currentTarget as HTMLElement;
    const dragId = memberUnder(target);

    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      touchStartRef.current = null;

      const containerEl = headerEl.closest('.pane-layout');
      const containerRect = containerEl?.getBoundingClientRect();
      send({
        type: 'DRAG_START',
        paneId: dragId,
        startX,
        startY,
        containerLeft: containerRect?.left ?? 0,
        containerTop: containerRect?.top ?? 0,
        tabStrip: measureTabStrip(),
      });
    }, LONG_PRESS_MS);

    const handleTouchMove = (moveEvt: TouchEvent) => {
      if (!touchStartRef.current) {
        // The drag started: the drag machine's pointerTracker has it.
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
        document.removeEventListener('touchcancel', handleTouchEnd);
        return;
      }
      const t = moveEvt.touches[0];
      const dx = Math.abs(t.clientX - touchStartRef.current.x);
      const dy = Math.abs(t.clientY - touchStartRef.current.y);
      if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
        // The user is scrolling.
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

  // A tab may hold no control of its own (ARIA), so a member's ⋮ and ✕ are
  // pointer targets hidden from assistive technology; the tab's context menu
  // carries the same actions.
  const controlsFor = (forPaneId: PaneId) => (
    <span className="pane-tab-controls" aria-hidden="true">
      <Tooltip label="Pane menu">
        <span className="pane-header-menu" onClick={(e) => handleMenuClick(e, forPaneId)}>
          ⋮
        </span>
      </Tooltip>
      <Tooltip label="Close pane">
        <span
          className="pane-header-close"
          onClick={(e) => {
            e.stopPropagation();
            // In a float only the shown member's ✕ closes the float; a parked
            // member's closes that member.
            if (isFloat && forPaneId === activeTabId) onFloatClose?.();
            else handleClosePane(e, forPaneId);
          }}
        >
          ✕
        </span>
      </Tooltip>
    </span>
  );

  const menuPaneId = contextMenu.visible ? contextMenu.targetPaneId : null;

  return (
    <div
      className={headerClass}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleHeaderMouseDown}
      onTouchStart={handleHeaderTouchStart}
      // Outside a member's tab the header is the shown pane's; a tab handles
      // (and stops) its own right-click.
      onContextMenu={(e) => handleContextMenu(e, activeTabId)}
    >
      {/* The tab list is the strip of titles alone: the ⋮ and ✕ beside it are
          buttons, which a tablist may not hold. */}
      <div
        className={`pane-tabs${isGroup ? ' pane-tabs-group' : ''}`}
        ref={tabsRef}
        role="tablist"
        aria-label="Pane tabs"
      >
        {tabPanes.map((tabPane, index) => {
          const isSelectedTab = tabPane.tmuxId === activeTabId;
          const isActivePane = tabPane.active && isSelectedTab;

          return (
            <PaneTab
              key={tabPane.tmuxId}
              pane={tabPane}
              isSelectedTab={isSelectedTab}
              isActivePane={isActivePane}
              titleOverride={tabPane.tmuxId === paneId ? titleOverride : undefined}
              renaming={renamingPaneId === tabPane.tmuxId}
              onRenameEnd={(name) => {
                send({ type: 'PANE_RENAME_END' });
                if (name) {
                  send({
                    type: 'DISPATCH_OP',
                    op: TmuxOp.SetPaneTitle({ paneId: tabPane.tmuxId, title: name }),
                  });
                }
              }}
              onClick={(e) => handleTabClick(e, tabPane.tmuxId)}
              onContextMenu={(e) => handleContextMenu(e, tabPane.tmuxId)}
              controls={isGroup ? controlsFor(tabPane.tmuxId) : null}
              dropMark={dropMarkFor(index)}
              dragging={isGroup && draggedPaneId === tabPane.tmuxId}
            />
          );
        })}
      </div>
      {/* Marked (`prefix m`) is a state of the pane shown here, not of every
          tab in the strip. Spelled out: a lone ⚑ says nothing about what it marks. */}
      {shownPane?.marked && (
        <Tooltip label={markedTooltip(keybindings)}>
          <span className="pane-header-mark" data-testid="pane-header-mark">
            MARKED<span aria-hidden="true"> ⚑</span>
          </span>
        </Tooltip>
      )}
      {!isGroup && (
        <>
          <Tooltip label="Pane menu">
            <button
              className="pane-header-menu"
              onClick={handleMenuClick}
              aria-haspopup="menu"
              aria-label="Pane menu"
            >
              ⋮
            </button>
          </Tooltip>
          <Tooltip label="Close pane">
            <button
              className="pane-header-close"
              onClick={(e) => {
                e.stopPropagation();
                if (isFloat) onFloatClose?.();
                else handleClosePane(e);
              }}
              aria-label="Close pane"
            >
              ✕
            </button>
          </Tooltip>
        </>
      )}
      {menuPaneId && (
        <PaneContextMenu
          paneId={menuPaneId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onRename={() => send({ type: 'RENAME_PANE', paneId: menuPaneId })}
        />
      )}
    </div>
  );
}
