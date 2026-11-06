/**
 * No tab carries a ✕: a strip of accidental targets is a strip you cannot
 * click confidently, and closing lives in the tab's context menu, its card in
 * the all-tabs view and the hover preview.
 *
 * A pane dragged onto the strip belongs to the drag machine, which owns the
 * pointer; the strip only shows where the drop would land.
 */

import { memo, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useAppSend, useAppSelector, useAppSelectorShallow } from '../machines/appHooks';
import { selectVisibleWindows } from '../machines/selectors/panesAndSidebars';
import { selectTabDrop } from '../machines/selectors/layout';
import { selectAnimationsAllowed } from '../machines/selectors/ui';
import { TabContextMenu } from './TabContextMenu';
import { haptics } from '../infra/haptics';
import { LogProfiler } from './renderLog';
import { useReorderDrag } from './useReorderDrag';
import type { TmuxWindow } from '../domain/client';
import { TabPreview, TAB_PREVIEW_DELAY_MS } from './TabPreview';
import { isModelWindowId, type WindowId } from '../domain/ids';
import type { PaneStateName } from '../domain/paneState';
import { selectTabStates, useShowActiveTab } from './windowTabState';
import { WindowTabItem } from './WindowTabItem';
import './WindowTabs.css';

/**
 * How long the hover card survives the pointer leaving the strip. Just enough
 * to cross the gap between a tab and the card below it.
 */
const PREVIEW_GRACE_MS = 180;

interface TabContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  windowId: WindowId | null;
  /** Set when the menu is taking a preview card's place. */
  anchorEl: HTMLElement | null;
  morphFrom: DOMRect | null;
}

export const WindowTabs = memo(function WindowTabs() {
  const send = useAppSend();
  const rawWindows = useAppSelectorShallow(selectVisibleWindows);
  const tabStateEntries = useAppSelectorShallow(selectTabStates);
  const tabStates = useMemo(
    () =>
      new Map(
        tabStateEntries.map((entry) => {
          const at = entry.indexOf('=');
          return [entry.slice(0, at), entry.slice(at + 1) as PaneStateName];
        }),
      ),
    [tabStateEntries],
  );
  const tabDrop = useAppSelector(selectTabDrop);
  const animationsAllowed = useAppSelector(selectAnimationsAllowed);
  const listRef = useRef<HTMLDivElement>(null);
  const suppressClickRef = useRef(false);
  const renamingId = useAppSelector((c) => c.renamingTabId);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const dismissPreviewRef = useRef<() => void>(() => {});
  /**
   * The card on screen when the current press began, which the context menu
   * grows out of. Read at `pointerdown`, not `contextmenu`: the press itself
   * puts the card away, so by `contextmenu` it is already leaving.
   */
  const pressedPreviewRef = useRef<{ windowId: WindowId; rect: DOMRect } | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    windowId: null,
    anchorEl: null,
    morphFrom: null,
  });

  // Guard: no duplicate window ids reach the DOM as React keys.
  const visibleWindows = useMemo(
    () => [...new Map(rawWindows.map((w) => [w.id, w])).values()],
    [rawWindows],
  );

  const handleWindowClick = useCallback(
    (window: TmuxWindow) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      haptics.trigger(10);
      send({ type: 'SELECT_TAB', windowId: window.id });
    },
    [send],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, windowId: WindowId) => {
    e.preventDefault();
    e.stopPropagation();
    // The preview turns into the menu, rather than the menu drawing over its
    // own preview; with no card up it opens at the pointer.
    const pressed = pressedPreviewRef.current;
    const morphFrom = pressed?.windowId === windowId ? pressed.rect : null;
    const anchorEl = morphFrom ? (e.currentTarget as HTMLElement) : null;
    dismissPreviewRef.current();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, windowId, anchorEl, morphFrom });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const isSingleTab = visibleWindows.length === 1;
  const activeWindowId = visibleWindows.find((w) => w.active)?.id ?? null;

  useShowActiveTab(listRef, activeWindowId, animationsAllowed, visibleWindows.length);

  const clearPreviewTimer = () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  };

  const handleTabEnter = (e: React.PointerEvent<HTMLSpanElement>, windowId: WindowId) => {
    // A finger on a tab is pressing it, not asking about it.
    if (e.pointerType !== 'mouse') return;
    cancelClose();
    if (previewId !== null) {
      clearPreviewTimer();
      setPreviewId(windowId);
      return;
    }
    clearPreviewTimer();
    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = null;
      setPreviewId(windowId);
    }, TAB_PREVIEW_DELAY_MS);
  };

  // Leaving the strip ends the browse after a grace period, so the pointer can
  // cross the gap to the card below; the card cancels it on the way in.
  const closeTimerRef = useRef<number | null>(null);
  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setPreviewId(null);
    }, PREVIEW_GRACE_MS);
  };

  const handleStripLeave = () => {
    clearPreviewTimer();
    scheduleClose();
  };

  const dismissPreview = () => {
    clearPreviewTimer();
    cancelClose();
    setPreviewId(null);
  };
  // `handleContextMenu` is declared above this and is memoised, so it reads the
  // dismiss through a ref rather than closing over the render that made it.
  dismissPreviewRef.current = dismissPreview;

  useEffect(
    () => () => {
      clearPreviewTimer();
      cancelClose();
    },
    [],
  );

  const previewWindow = visibleWindows.find((w) => w.id === previewId) ?? null;
  const previewIndex = visibleWindows.findIndex((w) => w.id === previewId) + 1;

  const reorder = useReorderDrag({
    containerRef: listRef,
    cardSelector: '.tab-name[data-window-id]',
    axis: 'x',
    onReorder: (windowId, toIndex) => {
      haptics.trigger(10);
      send({ type: 'REORDER_TAB', windowId, toIndex });
    },
  });

  const handlePointerDown = (e: React.PointerEvent<HTMLSpanElement>, index: number) => {
    // Before the card goes: a right-click turns it into the menu, and the menu
    // needs the box it is growing out of (see `pressedPreviewRef`).
    const card = document.querySelector<HTMLElement>(
      '[data-testid="tab-preview"]:not(.is-leaving)',
    );
    const cardWindowId = card?.dataset.windowId;
    pressedPreviewRef.current =
      card && isModelWindowId(cardWindowId)
        ? { windowId: cardWindowId, rect: card.getBoundingClientRect() }
        : null;
    dismissPreview();
    const tab = visibleWindows[index];
    // A lone tab is the desktop window's drag handle, not a control.
    if (!tab || isSingleTab || e.button !== 0) return;
    if (renamingId === tab.id) return;
    if ((e.target as HTMLElement).closest('button')) return;
    reorder.handlePointerDown(e, tab.id, index);
  };

  // The browser fires a click after a drop; `handleWindowClick` swallows it.
  const handlePointerUp = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (reorder.handlePointerUp(e)?.active) suppressClickRef.current = true;
  };

  const menuWindowId = contextMenu.visible ? contextMenu.windowId : null;

  return (
    <LogProfiler id="WindowTabs">
      <div
        ref={listRef}
        className={`tab-list${isSingleTab ? ' tab-list-single' : ''}`}
        onPointerLeave={handleStripLeave}
        role="tablist"
        aria-label="Tabs"
        // The strip is one tab stop, so the keyboard can reach it and scroll it.
        tabIndex={0}
      >
        {visibleWindows.map((window, idx) => (
          <WindowTabItem
            key={window.id}
            window={window}
            idx={idx}
            visibleWindowsLength={visibleWindows.length}
            previewId={previewId}
            renamingId={renamingId}
            tabStates={tabStates}
            tabDrop={tabDrop}
            reorder={reorder}
            handlePointerDown={handlePointerDown}
            handlePointerUp={handlePointerUp}
            handleTabEnter={handleTabEnter}
            handleWindowClick={handleWindowClick}
            handleContextMenu={handleContextMenu}
            send={send}
          />
        ))}
        {tabDrop?.kind === 'new' && (
          <span className="tab-new-drop" aria-hidden="true">
            New Tab
          </span>
        )}
        {/* Unmounted in the same commit the menu arrives in, so the card and
            the menu it becomes are never on screen together — structural
            rather than a race between two timers. */}
        {!contextMenu.visible && (
          <TabPreview
            windowId={previewWindow?.id ?? null}
            label={
              previewWindow ? `${previewIndex}:${previewWindow.name || `Tab ${previewIndex}`}` : ''
            }
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            onActivate={(id) => {
              dismissPreview();
              send({ type: 'SELECT_TAB', windowId: id });
            }}
            onDismiss={dismissPreview}
          />
        )}
        {menuWindowId && (
          <TabContextMenu
            windowId={menuWindowId}
            x={contextMenu.x}
            y={contextMenu.y}
            anchorEl={contextMenu.anchorEl}
            morphFrom={contextMenu.morphFrom}
            onClose={closeContextMenu}
            onRename={() => {
              dismissPreview();
              send({ type: 'RENAME_TAB', windowId: menuWindowId });
            }}
          />
        )}
      </div>
    </LogProfiler>
  );
});
