import { useCallback, useLayoutEffect, useRef } from 'react';
import type { WindowId } from '../domain/ids';
import { tabPaneStates } from '../domain/paneState';
import type { AppMachineContext } from '../machines/types/context';

/** Each tab's rolled-up pane state, as `<window id>=<state>` entries: equal
 *  item by item across updates that change pane content but no state, so the
 *  strip holds still. */
export function selectTabStates(context: AppMachineContext): string[] {
  const states = tabPaneStates(
    context.windows.map((w) => w.id),
    context.panes,
  );
  return [...states].map(([id, { state }]) => `${id}=${state}`);
}

// Switching by keyboard can land on a tab scrolled off the strip.
export function useShowActiveTab(
  listRef: React.RefObject<HTMLDivElement | null>,
  activeWindowId: WindowId | null,
  animationsAllowed: boolean,
  visibleWindowsLength: number,
) {
  /**
   * Returns whether the tab already was in view. The move is a delta, so each
   * call re-aims from wherever a smooth scroll in flight has got to.
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
    // Keep re-aiming for a moment: the strip's width, the pager buttons and
    // the tabs' own boxes land over the next paint or two, and each can push
    // the tab back off the edge — a strip growing WIDER fires no resize.
    // Bounded, so a later scroll by the user is never yanked back.
    const deadline = performance.now() + SHOW_ACTIVE_TAB_SETTLE_MS;
    let raf = requestAnimationFrame(function again() {
      const settled = showActiveTab();
      if (!settled || performance.now() < deadline) raf = requestAnimationFrame(again);
    });
    showActiveTab();
    return () => cancelAnimationFrame(raf);
  }, [showActiveTab, visibleWindowsLength]);

  // The pager buttons appear because the strip overflows and take their width
  // out of it, pushing a tab at the edge back off; so re-aim on every resize.
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

/** How long after a switch the strip keeps re-aiming at the current tab. */
const SHOW_ACTIVE_TAB_SETTLE_MS = 600;
