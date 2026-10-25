/**
 * WindowTabs - the tmux window tabs in the status bar.
 *
 * Tabs sit left-aligned at their natural width, so the rest of the strip stays
 * empty — and on the desktop that empty header is what drags the OS window
 * (see StatusBar). A lone tab sits in that same left-aligned position with the
 * `+` directly after it, takes no hover background, and is itself a drag handle
 * for the window: with nothing to switch to, it is a label on the window
 * rather than a control.
 *
 * No tab carries a ✕. A strip of buttons each with a target you can hit by
 * accident is a strip you cannot click confidently, and closing has three
 * unhurried homes already: the tab's context menu, its card in the all-tabs
 * view, and the hover preview.
 *
 * The active tab is marked by BRIGHTNESS alone — full opacity and pure white
 * against the others' dimmed grey — with no pill or background behind it.
 *
 * A click selects; a press that travels (a mouse after a few pixels, a finger
 * after a long press) drags the tab along the strip and drops it at a new
 * position, reordering tmux's windows the way the Tab Overview does. The drag
 * is transient pointer state and stays here; the click the browser fires after
 * a drop is swallowed so a drop never doubles as a select.
 *
 * Right-click opens a context menu with tab operations.
 *
 * Resting on a tab shows a picture of it (TabPreview). The first one waits a
 * second, because a pointer crossing the strip on its way somewhere else is
 * not asking for anything; after that, moving along the strip slides the same
 * card from tab to tab, so browsing is browsing rather than a second's wait at
 * every stop. Leaving the strip ends it.
 *
 * The strip is also where a dragged PANE is dropped to leave its tab. That
 * gesture belongs to the drag machine, which owns the pointer for its whole
 * life; all the strip does is read where the drop would land and say so — the
 * tab under the pointer lights up, and past the last tab a dashed "New Tab"
 * placeholder appears in the empty space.
 */

import { memo, useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { useAppSend, useAppSelector, useAppSelectorShallow } from '../machines/appHooks';
import { selectVisibleWindows } from '../machines/selectors/panesAndSidebars';
import { selectTabDrop } from '../machines/selectors/layout';
import { selectAnimationsAllowed } from '../machines/selectors/ui';
import { TabContextMenu } from './TabContextMenu';
import { haptics } from '../utils/haptics';
import { LogProfiler } from '../utils/renderLog';
import { useReorderDrag } from '../hooks/useReorderDrag';
import type { TmuxWindow } from '../domain/client';
import { TabPreview, TAB_PREVIEW_DELAY_MS } from './TabPreview';
import { isModelWindowId, type WindowId } from '../domain/ids';
import type { PaneStateName } from '../utils/paneState';
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
  /** The tab's button, when the menu is taking a preview card's place. */
  anchorEl: HTMLElement | null;
  /** That card's box, for the menu to grow out of. */
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
  // The tab being renamed, if any: the field takes the label's place. Opened
  // by the tab's context menu, or by Rename Tab in the app menu and the
  // native menu bar, which name the active tab.
  const renamingId = useAppSelector((c) => c.renamingTabId);
  // The tab whose picture is showing, and the timer waiting to show the first.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const dismissPreviewRef = useRef<() => void>(() => {});
  /**
   * The card that was on screen when the current press began, and its box.
   *
   * Read at `pointerdown` rather than at `contextmenu`, because the press
   * itself puts the card away (a press is an action on the tab, and the
   * picture is in the way of seeing what it did) — by the time the context
   * menu is asked for, the card is already playing its exit. This is what the
   * menu grows out of.
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

  // Dedup safety net: ensure no duplicate window IDs reach the DOM
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
    // The preview TURNS INTO the menu. Right-clicking a tab you are already
    // looking at used to draw the menu on top of its own preview — two cards
    // about the same tab, overlapping, one of them now unreachable. Now the
    // card's box is handed to the menu, which opens under the same tab and
    // grows out of it: one surface about one tab, and one object rather than
    // a disappearance and an appearance. With no card up (a tab crossed on
    // the way past) the menu opens at the pointer, as any context menu does.
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

  // ---- hover: the tab picture -----------------------------------------------
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
    // Already browsing: keep up with the pointer instead of waiting again.
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

  // Leaving the STRIP ends the browse; leaving one tab for the next does not,
  // which is what lets the same card slide along instead of blinking out.
  //
  // Not at once, though: the card sits just below the strip, and the pointer
  // has to cross the gap to reach it. A grace period covers that crossing, and
  // the card cancels it on the way in — otherwise a card you are reaching for
  // is a card that closes as you reach.
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

  // A press is an action on the tab, and the picture is in the way of seeing
  // what it did.
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

  // ---- pointer: drag to reorder --------------------------------------------
  // The strip is one row, so only the x axis decides where a tab lands.
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
    // A tab being renamed is a field, not a thing to drag.
    if (renamingId === tab.id) return;
    if ((e.target as HTMLElement).closest('button')) return;
    reorder.handlePointerDown(e, tab.id, index);
  };

  // A drop never doubles as a select: the click the browser fires after it is
  // swallowed by `handleWindowClick`.
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
        {/* Where a pane dropped past the last tab would go. It sits in the
            strip's own flow so it takes the space it would occupy. */}
        {tabDrop?.kind === 'new' && (
          <span className="tab-new-drop" aria-hidden="true">
            New Tab
          </span>
        )}
        {/* Mounted except while the context menu is up: the card owns its own
            exit, and unmounting it would normally take that animation with it —
            but the menu IS this card, and the two must never be on screen
            together. Going in the same commit the menu arrives in is what makes
            that structural rather than a race between two timers. */}
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
            // Another floating surface took the layer (the app menu, a pane's
            // context menu). The card is not a peer that argues; it goes.
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
