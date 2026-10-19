/**
 * Tab strip state shared by WindowTabs and WindowTabItem.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { WindowId } from '../domain/ids';
import { tabPaneStates } from '../utils/paneState';
import type { AppMachineContext } from '../machines/types/context';

/**
 * Memoized (no props): context.windows gets a fresh array identity on every
 * model tick; the shallow selectors below keep re-renders to actual window
 * changes, and the memo shields against parent re-renders.
 */
/** Each tab's rolled-up pane state, as `<window id>=<state>` entries: equal
 *  item by item across updates that change pane content but no state, so the
 *  strip holds still. */
export function selectTabStates(context: AppMachineContext): string[] {
  const states = tabPaneStates(
    context.windows.map((w) => w.id),
    context.panes,
    context.unreadPaneIds,
  );
  return [...states].map(([id, { state }]) => `${id}=${state}`);
}

// ---- keep the current tab reachable --------------------------------------
// With more tabs than fit, switching by keyboard (ctrl+N, prefix n/p) can
// land on a tab that is scrolled off the strip: the tab you are now looking
// at would be the one you cannot see.
export function useShowActiveTab(
  listRef: React.RefObject<HTMLDivElement | null>,
  activeWindowId: WindowId | null,
  animationsAllowed: boolean,
  visibleWindowsLength: number,
) {
  /**
   * Bring the current tab into view, and say whether it already was.
   *
   * The move is a DELTA rather than an absolute target, so each call re-aims
   * from wherever the strip has got to — which matters because the strip is
   * still settling on the commit that switches tabs, and because a smooth
   * scroll is in flight while it does.
   */
  const showActiveTab = useCallback((): boolean => {
    const list = listRef.current;
    if (!list || !activeWindowId) return true;
    if (list.scrollWidth <= list.clientWidth) return true;
    const tab = list.querySelector<HTMLElement>(`.tab-name[data-window-id="${activeWindowId}"]`);
    if (!tab) return true;
    const tabBox = tab.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const behind = listBox.left - tabBox.left;
    const past = tabBox.right - listBox.right;
    if (behind <= 0 && past <= 0) return true;
    list.scrollTo({
      left: list.scrollLeft + (behind > 0 ? -behind : past),
      behavior: animationsAllowed ? 'smooth' : 'auto',
    });
    return false;
  }, [listRef, activeWindowId, animationsAllowed]);

  useLayoutEffect(() => {
    // Keep re-aiming until it sticks, for a moment. The strip's width, the
    // pager buttons and the tabs' own boxes all land over the next paint or
    // two, and each of them can push a tab that was just brought to the edge
    // back off it — the strip growing WIDER is not a resize of the strip, so
    // nothing else would notice. Bounded, so a scroll the user makes later is
    // never yanked back.
    const deadline = performance.now() + SHOW_ACTIVE_TAB_SETTLE_MS;
    let raf = requestAnimationFrame(function again() {
      const settled = showActiveTab();
      if (!settled || performance.now() < deadline) raf = requestAnimationFrame(again);
    });
    showActiveTab();
    return () => cancelAnimationFrame(raf);
  }, [showActiveTab, visibleWindowsLength]);

  // ...and again whenever the strip changes size under it. The pager buttons
  // are the reason: they appear precisely BECAUSE the strip overflows, and
  // they take their width out of it, so a tab scrolled to the edge a moment
  // earlier is pushed back off it. A window resize and a sidebar opening do
  // the same thing.
  const showActiveTabRef = useRef(showActiveTab);
  showActiveTabRef.current = showActiveTab;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => showActiveTabRef.current());
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef]);
}

/**
 * How long the strip keeps checking that the current tab is still in view
 * after a switch. Long enough for the layout around it to settle, short
 * enough that a scroll the user makes afterwards is left alone.
 */
const SHOW_ACTIVE_TAB_SETTLE_MS = 600;
