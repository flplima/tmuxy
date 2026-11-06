/**
 * One finger on a pane scrolls it the way a wheel does, with momentum after
 * the lift. In the phone layout one finger also means:
 * - a tap focuses the pane, and an open keyboard follows it; a tap on the pane
 *   that already has the keyboard puts the keyboard up or away, as the key
 *   row's ⌨ key does;
 * - a double tap zooms the terminal in the browser around the tap, and again
 *   puts it back; zoomed, the finger pans the browser;
 * - a hold selects the word under the finger in copy mode and a drag extends
 *   it, until TouchSelectionBar's Copy or Cancel;
 * - a sideways slide pulls the next tab in, as the desktop's two-finger slide does.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Effect, Fiber } from 'effect';
import type { AppMachineEvent } from '../../machines/types/events';
import { sendScrollLines, takeWholeRows, scrollByRows } from './scrollUtils';
import { clientToCell } from './paneMouseHelpers';
import { focusMobileInput, toggleMobileKeyboard } from '../../infra/dom/mobileKeyboard';
import { haptics } from '../../infra/haptics';
import {
  HOLD_MS,
  decideIntent,
  isDoubleTap,
  isTap,
  releaseSpeed,
  type TouchIntent,
  type TouchPoint,
} from '../phone/touchGesture';
import type { PaneId } from '../../domain/ids';

const nextFrame = Effect.async<number>((resume) => {
  const id = requestAnimationFrame((t) => resume(Effect.succeed(t)));
  return Effect.sync(() => cancelAnimationFrame(id));
});

interface UsePaneTouchOptions {
  paneId: PaneId;
  charWidth: number;
  charHeight: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  send: (event: AppMachineEvent) => void;
  historySize: number;
  paneHeight: number;
  /** Either scrollback view is open. */
  scrollbackOpen: boolean;
  /** tmux's copy mode, not the scroll view. */
  copyModeActive: boolean;
  phoneLayout: boolean;
  phoneZoomed: boolean;
  holdsKeyboard: boolean;
  forwardScrollToParent?: boolean;
}

/** Decay per millisecond, tuned to feel like iOS's UIScrollView. */
const DECELERATION_RATE = 0.995;

/** px/ms */
const MIN_VELOCITY = 0.03;

/** px/ms */
const MAX_VELOCITY = 5;

const VELOCITY_SAMPLES = 3;

const point = (touch: { clientX: number; clientY: number }, t: number): TouchPoint => ({
  x: touch.clientX,
  y: touch.clientY,
  t,
});

export function usePaneTouch(options: UsePaneTouchOptions) {
  const {
    paneId,
    charWidth,
    charHeight,
    alternateOn,
    mouseAnyFlag,
    scrollRef,
    contentRef,
    send,
    historySize,
    paneHeight,
    scrollbackOpen,
    copyModeActive,
    phoneLayout,
    phoneZoomed,
    holdsKeyboard,
    forwardScrollToParent,
  } = options;

  const lastTouchYRef = useRef(0);
  const remainderRef = useRef(0);
  const momentumFiberRef = useRef<Fiber.RuntimeFiber<void, never> | null>(null);
  const startRef = useRef<TouchPoint | null>(null);
  const intentRef = useRef<TouchIntent>('undecided');
  const lastTapRef = useRef<TouchPoint | null>(null);
  const lastTapToggledRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  // The finger on the screen started on THIS pane: the move and end listeners
  // sit on the window (usePaneNativeListeners).
  const gestureRef = useRef(false);

  const velocitySamplesRef = useRef<Array<{ t: number; y: number }>>([]);
  const slideSamplesRef = useRef<TouchPoint[]>([]);

  const cancelMomentum = useCallback(() => {
    if (momentumFiberRef.current !== null) {
      Effect.runFork(Fiber.interrupt(momentumFiberRef.current));
      momentumFiberRef.current = null;
    }
  }, []);

  const cancelHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cancelMomentum();
      cancelHold();
    },
    [cancelMomentum, cancelHold],
  );

  const pixelToCell = useCallback(
    (p: { x: number; y: number }) =>
      clientToCell(
        { clientX: p.x, clientY: p.y },
        scrollRef.current,
        contentRef.current,
        charWidth,
        charHeight,
      ),
    [scrollRef, contentRef, charWidth, charHeight],
  );

  // Positive deltaPixels = finger moved down = scroll up (natural scrolling).
  const processPixelDelta = useCallback(
    (deltaPixels: number) => {
      if (alternateOn || mouseAnyFlag) {
        const { rows: lines, remainder } = takeWholeRows(
          -deltaPixels,
          charHeight,
          remainderRef.current,
        );
        remainderRef.current = remainder;
        if (lines === 0) return;

        sendScrollLines({
          send,
          paneId,
          lines,
          alternateOn,
          mouseAnyFlag,
        });
      } else if (scrollbackOpen) {
        const { rows, remainder } = takeWholeRows(-deltaPixels, charHeight, remainderRef.current);
        remainderRef.current = remainder;
        if (scrollRef.current) scrollByRows(scrollRef.current, rows, charHeight);
      } else if (historySize > 0 && deltaPixels > 0) {
        // Opens the scroll view, as a wheel-up does: until then the container
        // is pinned to the bottom.
        const { rows: lines, remainder } = takeWholeRows(
          -deltaPixels,
          charHeight,
          remainderRef.current,
        );
        remainderRef.current = remainder;
        if (lines === 0) return;
        send({ type: 'ENTER_SCROLL_MODE', paneId, scrollLines: lines });
      }
    },
    [send, paneId, charHeight, alternateOn, mouseAnyFlag, scrollRef, scrollbackOpen, historySize],
  );

  // An alternate screen or a mouse-tracking program has no scrollback behind
  // what is on the screen to select in.
  const canHold = phoneLayout && !alternateOn && !mouseAnyFlag;
  // With a view open, a sideways drag is more likely reaching for the selection.
  const canSwipe = phoneLayout && !scrollbackOpen;

  const beginHold = useCallback(
    (start: TouchPoint) => {
      intentRef.current = 'hold';
      haptics.trigger(20);
      const cell = pixelToCell(start);
      const row = Math.max(0, Math.min(cell.y, paneHeight - 1));
      if (!copyModeActive) send({ type: 'ENTER_COPY_MODE', paneId });
      send({ type: 'COPY_MODE_WORD_SELECT', paneId, row, col: cell.x });
    },
    [send, paneId, pixelToCell, paneHeight, copyModeActive],
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      // A preventDefault here would suppress the Copy / Cancel bar's click.
      if (e.target instanceof Element && e.target.closest('.touch-selection-bar')) return;

      cancelMomentum();
      cancelHold();
      gestureRef.current = true;
      intentRef.current = 'undecided';
      remainderRef.current = 0;

      const touch = e.touches[0];
      const start = point(touch, e.timeStamp);
      startRef.current = start;
      lastTouchYRef.current = touch.clientY;
      velocitySamplesRef.current = [{ t: e.timeStamp, y: touch.clientY }];
      slideSamplesRef.current = [start];

      if (canHold && !phoneZoomed) {
        // Otherwise a finger resting on text is the browser's long press (its
        // own selection, or a context menu), which cancels the touch.
        e.preventDefault();
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          if (gestureRef.current && intentRef.current === 'undecided') beginHold(start);
        }, HOLD_MS);
      }
    },
    [cancelMomentum, cancelHold, canHold, phoneZoomed, beginHold],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!gestureRef.current) return;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const now = point(touch, e.timeStamp);
      const start = startRef.current ?? now;

      // Zoomed in, the browser pans the terminal, whichever way the finger goes.
      if (phoneZoomed) {
        if (decideIntent(start, now, false) !== 'undecided') {
          cancelHold();
          intentRef.current = 'scroll';
        }
        return;
      }

      if (intentRef.current === 'undecided') {
        intentRef.current = decideIntent(start, now, canSwipe);
        if (intentRef.current !== 'undecided') cancelHold();
      }

      switch (intentRef.current) {
        case 'undecided':
          return;
        case 'hold': {
          e.preventDefault();
          const cell = pixelToCell(now);
          send({
            type: 'COPY_MODE_CURSOR_MOVE',
            paneId,
            row: Math.max(0, Math.min(cell.y, paneHeight - 1)),
            col: cell.x,
            relative: true,
          });
          return;
        }
        case 'swipe': {
          e.preventDefault();
          const samples = slideSamplesRef.current;
          samples.push(now);
          if (samples.length > VELOCITY_SAMPLES + 1) {
            samples.splice(0, samples.length - VELOCITY_SAMPLES - 1);
          }
          send({ type: 'GESTURE_SWIPE', dx: now.x - start.x });
          return;
        }
        case 'scroll':
          break;
      }

      if (forwardScrollToParent && historySize === 0 && !alternateOn && !mouseAnyFlag) {
        return;
      }
      e.preventDefault(); // Prevent browser scroll/pull-to-refresh

      const deltaY = touch.clientY - lastTouchYRef.current;
      lastTouchYRef.current = touch.clientY;

      const samples = velocitySamplesRef.current;
      samples.push({ t: e.timeStamp, y: touch.clientY });
      if (samples.length > VELOCITY_SAMPLES + 1) {
        samples.splice(0, samples.length - VELOCITY_SAMPLES - 1);
      }

      processPixelDelta(deltaY);
    },
    [
      processPixelDelta,
      forwardScrollToParent,
      historySize,
      alternateOn,
      mouseAnyFlag,
      canSwipe,
      cancelHold,
      phoneZoomed,
      pixelToCell,
      send,
      paneId,
      paneHeight,
    ],
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (!gestureRef.current) return;
      gestureRef.current = false;
      cancelHold();
      const intent = intentRef.current;
      intentRef.current = 'undecided';
      const start = startRef.current;
      startRef.current = null;

      if (intent === 'swipe') {
        send({ type: 'GESTURE_SWIPE_END', speed: releaseSpeed(slideSamplesRef.current) });
        return;
      }
      if (intent === 'hold') return;

      if (intent === 'undecided' && start && e.changedTouches.length === 1) {
        const tap = point(e.changedTouches[0], e.timeStamp);
        if (isTap(start, tap)) {
          // Suppresses the browser's synthetic mousedown/mouseup/click: that
          // mousedown would focus the pane wrapper (tabIndex=0), taking focus
          // from the hidden mobile input and closing the keyboard.
          e.preventDefault();
          if (phoneLayout && isDoubleTap(lastTapRef.current, tap)) {
            // The first tap of the pair toggled the keyboard (a phone brings
            // its keyboard up only inside the tap's own handler, never a
            // moment later), so this one puts it back.
            if (lastTapToggledRef.current) toggleMobileKeyboard(paneId);
            lastTapRef.current = null;
            lastTapToggledRef.current = false;
            haptics.trigger(15);
            send({ type: 'TOGGLE_PHONE_ZOOM', x: tap.x, y: tap.y });
            return;
          }
          lastTapRef.current = tap;
          haptics.trigger(10);
          send({ type: 'FOCUS_PANE', paneId });
          lastTapToggledRef.current = phoneLayout && holdsKeyboard;
          if (lastTapToggledRef.current) toggleMobileKeyboard(paneId);
          else focusMobileInput(paneId);
          return;
        }
      }
      if (phoneZoomed) return;

      const samples = velocitySamplesRef.current;
      if (samples.length < 2) return;

      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt <= 0) return;

      let velocity = (last.y - first.y) / dt; // px/ms
      velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));

      if (Math.abs(velocity) < MIN_VELOCITY) return;

      let lastFrameTime = performance.now();

      const step = (): Effect.Effect<void> =>
        nextFrame.pipe(
          Effect.flatMap((now) => {
            const elapsed = now - lastFrameTime;
            lastFrameTime = now;

            velocity *= Math.pow(DECELERATION_RATE, elapsed);

            if (Math.abs(velocity) < MIN_VELOCITY) {
              remainderRef.current = 0;
              return Effect.void;
            }

            processPixelDelta(velocity * elapsed);
            return step();
          }),
        );

      momentumFiberRef.current = Effect.runFork(
        step().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              momentumFiberRef.current = null;
            }),
          ),
        ),
      );
    },
    [send, paneId, processPixelDelta, cancelHold, phoneLayout, phoneZoomed, holdsKeyboard],
  );

  // The browser took the touch (a system gesture, a dialog).
  const handleTouchCancel = useCallback(() => {
    if (!gestureRef.current) return;
    gestureRef.current = false;
    cancelHold();
    if (intentRef.current === 'swipe') send({ type: 'GESTURE_SWIPE_END', speed: 0 });
    intentRef.current = 'undecided';
    startRef.current = null;
  }, [cancelHold, send]);

  return {
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  };
}
