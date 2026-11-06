import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { readNativeSelection } from '../../infra/dom/nativeSelection';
import type { CopyModeState } from '../../domain/copyMode';
import type { AppMachineEvent } from '../../machines/types/events';
import type { PaneId } from '../../domain/ids';

export function useTerminalPaneScroll({
  paneId,
  charHeight,
  copyState,
  scrollRef,
  send,
}: UseTerminalPaneScrollOptions) {
  const suppressScrollRef = useRef(false);

  // A state scrollTop equal to this came from the DOM: syncing it back would
  // fight the native scroll with row snaps.
  const lastDomScrollTopRef = useRef<number | null>(null);

  const prevCopyScrollTopRef = useRef<number | null>(null);

  // A phone turned sideways changes the row height under a view whose row
  // did not move.
  const prevCharHeightRef = useRef(charHeight);

  const scrollIndicatorRef = useRef<HTMLDivElement | null>(null);
  const scrollIndicatorTimer = useRef<number | null>(null);

  const flashScrollIndicator = useCallback(() => {
    const el = scrollIndicatorRef.current;
    if (!el) return;
    el.style.opacity = '0.6';
    if (scrollIndicatorTimer.current) clearTimeout(scrollIndicatorTimer.current);
    scrollIndicatorTimer.current = window.setTimeout(() => {
      if (scrollIndicatorRef.current) scrollIndicatorRef.current.style.opacity = '0';
    }, 1200);
  }, []);

  const handleContainerScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (suppressScrollRef.current) return;

      if (copyState) {
        const el = e.currentTarget;
        const scrollTop = el.scrollTop;
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

  useLayoutEffect(() => {
    if (!copyState && scrollRef.current) {
      suppressScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      suppressScrollRef.current = false;
    }
  });

  // State -> DOM, for the changes that did not come from the DOM (keyboard).
  useLayoutEffect(() => {
    if (copyState && scrollRef.current) {
      const newScrollTop = copyState.scrollTop;
      const prevScrollTop = prevCopyScrollTopRef.current;
      prevCopyScrollTopRef.current = newScrollTop;
      const rowHeightChanged = charHeight !== prevCharHeightRef.current;
      prevCharHeightRef.current = charHeight;

      if (newScrollTop === prevScrollTop && !rowHeightChanged) return;

      if (
        !rowHeightChanged &&
        lastDomScrollTopRef.current !== null &&
        newScrollTop === lastDomScrollTopRef.current
      ) {
        lastDomScrollTopRef.current = null;
        return;
      }
      lastDomScrollTopRef.current = null;

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
      prevCharHeightRef.current = charHeight;
    }
  });

  // A tab the user is not on stays mounted but `display: none`, and a scroll
  // container with no box loses its offset (the state's `scrollTop` never
  // changed, so the sync above cannot see it). Coming back on screen is a
  // resize from nothing, so the offset is put back then.
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
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  const handleTouchStartRef = useRef(handleTouchStart);
  handleTouchStartRef.current = handleTouchStart;
  const handleTouchMoveRef = useRef(handleTouchMove);
  handleTouchMoveRef.current = handleTouchMove;
  const handleTouchEndRef = useRef(handleTouchEnd);
  handleTouchEndRef.current = handleTouchEnd;
  const handleTouchCancelRef = useRef(handleTouchCancel);
  handleTouchCancelRef.current = handleTouchCancel;

  // Native listeners: React's wheel and touch listeners are passive, so their
  // preventDefault() does nothing.
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
    // The rest of the gesture is watched on the WINDOW: a touch whose target
    // has left the document keeps being dispatched to that node and bubbles
    // nowhere. usePaneTouch ignores a move it did not see start on this pane.
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
