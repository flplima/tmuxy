/**
 * usePaneTouch - Touch event handler for panes (mobile scrolling)
 *
 * Provides native-feeling touch scrolling for terminal panes on mobile:
 * - Follows the finger with pixel-to-line accumulation
 * - Momentum/inertia scrolling after finger lifts
 * - Routes through the same three scroll modes as wheel events:
 *   1. Alternate screen (vim, less) → arrow keys
 *   2. Mouse tracking → SGR wheel events
 *   3. Normal shell → open the native-like scroll view, then proxy to its
 *      scroll container
 *
 * And, in the phone layout (utils/phoneLayout.ts), what else one finger
 * means (utils/touchGesture.ts):
 * - A tap focuses the pane; an open keyboard follows it, a closed one stays
 *   closed (the key row's ⌨ key toggles it).
 * - A double tap zooms the terminal in the browser, around the tap, and
 *   again puts it back. Zoomed, the finger pans: nothing here claims it.
 * - A hold selects the word under the finger in copy mode, and dragging on
 *   extends the selection; the Copy and Cancel buttons over the pane
 *   (components/TouchSelectionBar) end it.
 * - A sideways slide pulls the next tab in, as the desktop's two-finger
 *   slide does (GESTURE_SWIPE, actors/gestureActor.ts).
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Effect, Fiber } from 'effect';
import type { AppMachineEvent } from '../machines/types/events';
import { sendScrollLines, takeWholeRows, scrollByRows } from './scrollUtils';
import { clientToCell } from './paneMouseHelpers';
import { focusMobileInput } from '../utils/mobileKeyboard';
import { haptics } from '../utils/haptics';
import {
  HOLD_MS,
  decideIntent,
  isDoubleTap,
  isTap,
  releaseSpeed,
  type TouchIntent,
  type TouchPoint,
} from '../utils/touchGesture';
import type { PaneId } from '../domain/ids';

/** One animation frame as an Effect resolving to its rAF timestamp; its
 *  finalizer cancels the pending frame when the fiber is interrupted. */
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
  /** True while a scrollback view is already open (either kind). */
  scrollbackOpen: boolean;
  /** tmux's copy mode specifically: where a hold's selection lives. */
  copyModeActive: boolean;
  /** The phone layout: taps, holds, double taps and slides mean something. */
  phoneLayout: boolean;
  /** The phone's zoom is on: a moving finger pans the browser, not the pane. */
  phoneZoomed: boolean;
  forwardScrollToParent?: boolean;
}

/** Exponential decay rate per millisecond (tuned to feel like iOS UIScrollView) */
const DECELERATION_RATE = 0.995;

/** Stop momentum when velocity drops below this (px/ms) */
const MIN_VELOCITY = 0.03;

/** Maximum velocity cap to prevent runaway scrolling (px/ms) */
const MAX_VELOCITY = 5;

/** Number of recent touchmove samples to average for velocity calculation */
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
    forwardScrollToParent,
  } = options;

  // Touch tracking state
  const lastTouchYRef = useRef(0);
  const remainderRef = useRef(0);
  // The momentum animation as a supervised fiber. Interrupting it stops the
  // decay loop and cancels the pending frame (nextFrame's finalizer) — this
  // replaces both cancelAnimationFrame and the old "new touch started" guard.
  const momentumFiberRef = useRef<Fiber.RuntimeFiber<void, never> | null>(null);
  const startRef = useRef<TouchPoint | null>(null);
  // What the finger on the screen has turned out to be.
  const intentRef = useRef<TouchIntent>('undecided');
  // The last tap, for the double tap after it.
  const lastTapRef = useRef<TouchPoint | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  // Whether the finger currently on the screen started on THIS pane. The move
  // and end listeners sit on the window (see TerminalPane), because the row
  // the finger landed on is removed from the DOM the moment the scroll view
  // opens — and a touch event whose target has left the document no longer
  // bubbles to anything.
  const gestureRef = useRef(false);

  // Velocity tracking: store recent (timestamp, y) samples for averaging
  const velocitySamplesRef = useRef<Array<{ t: number; y: number }>>([]);
  // A slide's recent samples, for the speed it is released at.
  const slideSamplesRef = useRef<TouchPoint[]>([]);

  // Cancel any running momentum animation
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

  // Unmount cleanup: a flick that unmounts the pane (tmux kills it) would
  // otherwise keep the momentum loop mutating scrollTop / sending into a dead
  // pane until the velocity decays; a pending hold would select in it.
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

  // Process a pixel delta: accumulate into lines and dispatch
  // Returns unconsumed pixel remainder via the ref.
  // deltaY convention: positive = finger moved down = scroll UP (natural scrolling)
  const processPixelDelta = useCallback(
    (deltaPixels: number) => {
      if (alternateOn || mouseAnyFlag) {
        // Line-quantized mode: accumulate and send whole lines
        // Negate: finger down (positive deltaPixels) = scroll UP (negative lines)
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
        // A view is open: proxy the delta to its scroll container, a row at a
        // time (see scrollByRows). Negate: finger down = scroll up.
        const { rows, remainder } = takeWholeRows(-deltaPixels, charHeight, remainderRef.current);
        remainderRef.current = remainder;
        if (scrollRef.current) scrollByRows(scrollRef.current, rows, charHeight);
      } else if (historySize > 0 && deltaPixels > 0) {
        // Live screen, finger moving down, history behind it: open the scroll
        // view, exactly as a wheel-up does. Without this the container is
        // pinned to the bottom and the swipe goes nowhere.
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

  // A hold: the word under the finger, selected in copy mode. Not over an
  // alternate screen or a mouse-tracking program, whose scrollback is not
  // what is on the screen.
  const canHold = phoneLayout && !alternateOn && !mouseAnyFlag;
  // A slide between tabs: not while a view is open over the pane, where a
  // sideways drag is more likely to be reaching for the selection.
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
      // Only handle single-finger touch
      if (e.touches.length !== 1) return;
      // The Copy / Cancel bar over the pane is tapped like any button: a tap
      // taken here would suppress its click.
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
        // A finger resting on text would otherwise be the browser's long
        // press — its own selection, or a context menu — which cancels the
        // touch under us.
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

      // Zoomed in, the browser pans the terminal: a moving finger is its,
      // whichever way it goes.
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
          // The finger drags the selection's end, as a mouse drag does.
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

      // Record sample for velocity calculation
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

      // Tap detection: a lift inside the slop.
      if (intent === 'undecided' && start && e.changedTouches.length === 1) {
        const tap = point(e.changedTouches[0], e.timeStamp);
        if (isTap(start, tap)) {
          // Prevent synthetic mouse events (mousedown/mouseup/click) from firing.
          // Without this, the pane wrapper's tabIndex=0 receives a synthetic mousedown
          // which steals focus from the hidden mobile input and closes the keyboard.
          e.preventDefault();
          if (phoneLayout && isDoubleTap(lastTapRef.current, tap)) {
            lastTapRef.current = null;
            haptics.trigger(15);
            send({ type: 'TOGGLE_PHONE_ZOOM', x: tap.x, y: tap.y });
            return;
          }
          lastTapRef.current = tap;
          haptics.trigger(10);
          send({ type: 'FOCUS_PANE', paneId });
          focusMobileInput(paneId);
          return;
        }
      }
      if (phoneZoomed) return;

      // Calculate velocity from recent samples
      const samples = velocitySamplesRef.current;
      if (samples.length < 2) return;

      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = last.t - first.t;
      if (dt <= 0) return;

      let velocity = (last.y - first.y) / dt; // px/ms
      velocity = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, velocity));

      if (Math.abs(velocity) < MIN_VELOCITY) return;

      // Start momentum animation. A new touch (cancelMomentum in touchStart) or
      // unmount interrupts the fiber, which stops the loop and cancels the
      // pending frame — no touch-active guard needed.
      let lastFrameTime = performance.now();

      const step = (): Effect.Effect<void> =>
        nextFrame.pipe(
          Effect.flatMap((now) => {
            const elapsed = now - lastFrameTime;
            lastFrameTime = now;

            // Exponential decay
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
    [send, paneId, processPixelDelta, cancelHold, phoneLayout, phoneZoomed],
  );

  // The browser took the touch (a system gesture, a dialog): nothing was
  // tapped, and a slide in progress is let go where it was.
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
