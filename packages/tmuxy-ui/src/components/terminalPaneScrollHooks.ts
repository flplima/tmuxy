/**
 * Hooks behind TerminalPane's scrolling: the scroll model and the native listeners.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { readNativeSelection } from '../utils/nativeSelection';
import type { CopyModeState } from '../domain/copyMode';
import type { AppMachineEvent } from '../machines/types/events';
import type { PaneId } from '../domain/ids';

export function useTerminalPaneScroll({
  paneId,
  charHeight,
  copyState,
  scrollRef,
  send,
}: UseTerminalPaneScrollOptions) {
  // Track whether we're programmatically setting scroll to suppress onScroll feedback
  const suppressScrollRef = useRef(false);

  // Track the last scrollTop that came from the DOM (user wheel/scroll).
  // When the state machine's scrollTop matches this value, we skip syncing
  // DOM <- state to avoid fighting the native scroll with line-boundary snaps.
  const lastDomScrollTopRef = useRef<number | null>(null);

  // Track previous copy mode scrollTop to skip sync when it hasn't changed
  // (e.g. re-renders from chunk loads that don't alter scrollTop).
  const prevCopyScrollTopRef = useRef<number | null>(null);

  // Scroll indicator (direct DOM manipulation to avoid re-renders)
  const scrollIndicatorRef = useRef<HTMLDivElement | null>(null);
  const scrollIndicatorTimer = useRef<number | null>(null);

  // Context menu timeout refs (cleaned on unmount to prevent stale state updates)
  const flashScrollIndicator = useCallback(() => {
    const el = scrollIndicatorRef.current;
    if (!el) return;
    el.style.opacity = '0.6';
    if (scrollIndicatorTimer.current) clearTimeout(scrollIndicatorTimer.current);
    scrollIndicatorTimer.current = window.setTimeout(() => {
      if (scrollIndicatorRef.current) scrollIndicatorRef.current.style.opacity = '0';
    }, 1200);
  }, []);

  // onScroll: report the container's position while a scrollback view is open
  // (either kind). Opening one is the wheel handler's job, not this one's.
  const handleContainerScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (suppressScrollRef.current) return;

      if (copyState) {
        const el = e.currentTarget;
        const scrollTop = el.scrollTop;
        // Forward scroll position to state machine
        const newScrollTop = Math.floor(scrollTop / charHeight);
        lastDomScrollTopRef.current = newScrollTop;
        send({
          type: 'COPY_MODE_SCROLL',
          paneId,
          scrollTop: newScrollTop,
          nativeSelection: copyState.mode === 'scroll' && readNativeSelection().length > 0,
        });
        flashScrollIndicator();
      }
    },
    [send, paneId, charHeight, copyState, flashScrollIndicator],
  );

  // Keep scroll pinned to bottom in normal mode
  useLayoutEffect(() => {
    if (!copyState && scrollRef.current) {
      suppressScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      suppressScrollRef.current = false;
    }
  });

  // Sync scroll position from state -> DOM only for keyboard-initiated changes.
  // Skip when: (a) scrollTop hasn't changed (re-render from chunk load, etc.)
  //            (b) scrollTop matches lastDomScrollTopRef (change came from wheel)
  useLayoutEffect(() => {
    if (copyState && scrollRef.current) {
      const newScrollTop = copyState.scrollTop;
      const prevScrollTop = prevCopyScrollTopRef.current;
      prevCopyScrollTopRef.current = newScrollTop;

      // scrollTop didn't change — skip (chunk load, selection update, etc.)
      if (newScrollTop === prevScrollTop) return;

      // scrollTop changed but matches DOM-originated value — skip
      if (lastDomScrollTopRef.current !== null && newScrollTop === lastDomScrollTopRef.current) {
        lastDomScrollTopRef.current = null;
        return;
      }
      lastDomScrollTopRef.current = null;

      // Keyboard-initiated change — sync DOM to state
      const targetScroll = newScrollTop * charHeight;
      if (Math.abs(scrollRef.current.scrollTop - targetScroll) > 1) {
        suppressScrollRef.current = true;
        scrollRef.current.scrollTop = targetScroll;
        suppressScrollRef.current = false;
        flashScrollIndicator();
      }
    } else {
      prevCopyScrollTopRef.current = null;
      lastDomScrollTopRef.current = null;
    }
  });

  // A tab the user is not on stays mounted but `display: none`, and a scroll
  // container with no box loses its offset. Shown again, it sat at the top of
  // the spacer while the scrollback view rendered only the rows around its own
  // `scrollTop` — a blank pane — and the first wheel step, read from row 0,
  // threw the view to the start of history. The sync above cannot see this:
  // the state's `scrollTop` never changed. Coming back on screen is a resize
  // from nothing, so the offset is put back then.
  const latestRef = useRef({ copyState, charHeight });
  latestRef.current = { copyState, charHeight };
  const observedRef = useRef<{ el: HTMLElement; observer: ResizeObserver } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (observedRef.current?.el === el) return;
    observedRef.current?.observer.disconnect();
    observedRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let hidden = el.clientHeight === 0;
    const observer = new ResizeObserver(() => {
      const wasHidden = hidden;
      hidden = el.clientHeight === 0;
      if (!wasHidden || hidden) return;
      const { copyState: state, charHeight: rowHeight } = latestRef.current;
      suppressScrollRef.current = true;
      el.scrollTop = state ? state.scrollTop * rowHeight : el.scrollHeight;
      suppressScrollRef.current = false;
    });
    observer.observe(el);
    observedRef.current = { el, observer };
  });
  useEffect(() => () => observedRef.current?.observer.disconnect(), []);

  return { scrollIndicatorRef, handleContainerScroll };
}

export function usePaneNativeListeners({
  wrapperRef,
  handleWheel,
  handleTouchStart,
  handleTouchMove,
  handleTouchEnd,
  handleTouchCancel,
}: UsePaneNativeListenersOptions) {
  // Ref to latest handleWheel for the native listener
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  // Refs to latest touch handlers for native listeners
  const handleTouchStartRef = useRef(handleTouchStart);
  handleTouchStartRef.current = handleTouchStart;
  const handleTouchMoveRef = useRef(handleTouchMove);
  handleTouchMoveRef.current = handleTouchMove;
  const handleTouchEndRef = useRef(handleTouchEnd);
  handleTouchEndRef.current = handleTouchEnd;
  const handleTouchCancelRef = useRef(handleTouchCancel);
  handleTouchCancelRef.current = handleTouchCancel;

  // Native wheel and touch listeners with { passive: false } so preventDefault() works.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const wheelHandler = (e: WheelEvent) =>
      handleWheelRef.current(e as unknown as React.WheelEvent);
    const touchStartHandler = (e: TouchEvent) => handleTouchStartRef.current(e);
    const touchMoveHandler = (e: TouchEvent) => handleTouchMoveRef.current(e);
    const touchEndHandler = (e: TouchEvent) => handleTouchEndRef.current(e);
    const touchCancelHandler = () => handleTouchCancelRef.current();

    el.addEventListener('wheel', wheelHandler, { passive: false });
    // passive: false on the start too: a finger resting on text is a hold
    // (usePaneTouch), not the browser's long press.
    el.addEventListener('touchstart', touchStartHandler, { passive: false });
    // The rest of the gesture is watched on the WINDOW, not on the pane: the
    // finger lands on a terminal row, and opening the scroll view swaps every
    // row out of the document. A touch whose target has been removed keeps
    // being dispatched to that dead node and bubbles nowhere, so a pane-level
    // listener stopped hearing the swipe exactly when it had just begun —
    // the view opened one row above the live screen and went no further.
    // usePaneTouch ignores a move it did not see start on this pane.
    // passive: false so the handlers can call preventDefault(): on a move to
    // stop the page scrolling under the finger, and on a tap to suppress the
    // synthetic mouse events that would steal focus from the mobile
    // keyboard's hidden input.
    window.addEventListener('touchmove', touchMoveHandler, { passive: false });
    window.addEventListener('touchend', touchEndHandler, { passive: false });
    window.addEventListener('touchcancel', touchCancelHandler);
    return () => {
      el.removeEventListener('wheel', wheelHandler);
      el.removeEventListener('touchstart', touchStartHandler);
      window.removeEventListener('touchmove', touchMoveHandler);
      window.removeEventListener('touchend', touchEndHandler);
      window.removeEventListener('touchcancel', touchCancelHandler);
    };
  }, [wrapperRef]);
}

interface UseTerminalPaneScrollOptions {
  paneId: PaneId;
  charHeight: number;
  copyState: CopyModeState | undefined;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  send: (event: AppMachineEvent) => void;
}

interface UsePaneNativeListenersOptions {
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  handleWheel: (e: React.WheelEvent) => void;
  handleTouchStart: (e: TouchEvent) => void;
  handleTouchMove: (e: TouchEvent) => void;
  handleTouchEnd: (e: TouchEvent) => void;
  handleTouchCancel: () => void;
}
