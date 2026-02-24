/**
 * usePaneTouch - Touch event handler for panes (mobile scrolling)
 *
 * Provides native-feeling touch scrolling for terminal panes on mobile:
 * - Follows the finger with pixel-to-line accumulation
 * - Momentum/inertia scrolling after finger lifts
 * - Routes through the same three scroll modes as wheel events:
 *   1. Alternate screen (vim, less) → arrow keys
 *   2. Mouse tracking → SGR wheel events
 *   3. Normal shell → proxy to scroll container (enters copy mode)
 */

import { useCallback, useRef, type RefObject } from 'react';
import type { AppMachineEvent } from '../machines/types';
import { sendScrollLines } from './scrollUtils';

interface UsePaneTouchOptions {
  paneId: string;
  charHeight: number;
  alternateOn: boolean;
  mouseAnyFlag: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  send: (event: AppMachineEvent) => void;
}

/** Exponential decay rate per millisecond (tuned to feel like iOS UIScrollView) */
const DECELERATION_RATE = 0.995;

/** Stop momentum when velocity drops below this (px/ms) */
const MIN_VELOCITY = 0.03;

/** Maximum velocity cap to prevent runaway scrolling (px/ms) */
const MAX_VELOCITY = 5;

/** Number of recent touchmove samples to average for velocity calculation */
const VELOCITY_SAMPLES = 3;

export function usePaneTouch(options: UsePaneTouchOptions) {
  const { paneId, charHeight, alternateOn, mouseAnyFlag, scrollRef, send } = options;

  // Touch tracking state
  const lastTouchYRef = useRef(0);
  const remainderRef = useRef(0);
  const momentumRAFRef = useRef<number | null>(null);

  // Velocity tracking: store recent (timestamp, y) samples for averaging
  const velocitySamplesRef = useRef<Array<{ t: number; y: number }>>([]);

  // Whether touch is active (prevents momentum from running after a new touch)
  const touchActiveRef = useRef(false);

  // Cancel any running momentum animation
  const cancelMomentum = useCallback(() => {
    if (momentumRAFRef.current !== null) {
      cancelAnimationFrame(momentumRAFRef.current);
      momentumRAFRef.current = null;
    }
  }, []);

  // Process a pixel delta: accumulate into lines and dispatch
  // Returns unconsumed pixel remainder via the ref.
  // deltaY convention: positive = finger moved down = scroll UP (natural scrolling)
  const processPixelDelta = useCallback(
    (deltaPixels: number) => {
      if (alternateOn || mouseAnyFlag) {
        // Line-quantized mode: accumulate and send whole lines
        // Negate: finger down (positive deltaPixels) = scroll UP (negative lines)
        remainderRef.current += -deltaPixels;
        const lines = Math.trunc(remainderRef.current / charHeight);
        if (lines === 0) return;
        remainderRef.current -= lines * charHeight;

        sendScrollLines({
          send,
          paneId,
          lines,
          alternateOn,
          mouseAnyFlag,
        });
      } else {
        // Normal mode: proxy pixel delta to scroll container.
        // Negate: finger down = scroll up (decrease scrollTop)
        if (scrollRef.current) {
          scrollRef.current.scrollTop += -deltaPixels;
        }
      }
    },
    [send, paneId, charHeight, alternateOn, mouseAnyFlag, scrollRef],
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      // Only handle single-finger touch
      if (e.touches.length !== 1) return;

      touchActiveRef.current = true;
      cancelMomentum();
      remainderRef.current = 0;

      const touch = e.touches[0];
      lastTouchYRef.current = touch.clientY;
      velocitySamplesRef.current = [{ t: e.timeStamp, y: touch.clientY }];
    },
    [cancelMomentum],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      e.preventDefault(); // Prevent browser scroll/pull-to-refresh

      const touch = e.touches[0];
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
    [processPixelDelta],
  );

  const handleTouchEnd = useCallback(
    (_e: TouchEvent) => {
      touchActiveRef.current = false;

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

      // Start momentum animation
      let lastFrameTime = performance.now();

      const momentumTick = (now: number) => {
        if (touchActiveRef.current) return; // new touch started, stop

        const elapsed = now - lastFrameTime;
        lastFrameTime = now;

        // Exponential decay
        velocity *= Math.pow(DECELERATION_RATE, elapsed);

        if (Math.abs(velocity) < MIN_VELOCITY) {
          momentumRAFRef.current = null;
          remainderRef.current = 0;
          return;
        }

        const deltaPixels = velocity * elapsed;
        processPixelDelta(deltaPixels);

        momentumRAFRef.current = requestAnimationFrame(momentumTick);
      };

      momentumRAFRef.current = requestAnimationFrame(momentumTick);
    },
    [processPixelDelta],
  );

  return {
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    cancelMomentum,
  };
}
