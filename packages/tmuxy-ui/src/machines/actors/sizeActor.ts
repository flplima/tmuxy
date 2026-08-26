/**
 * Size Actor - Manages window resize and container size observation
 *
 * Factory pattern: createSizeActor(measureFn) => fromCallback(...)
 * Replaces useWindowResize + useContainerSize hooks.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import { calculateTargetSize } from '../../utils/layout';
import { CHAR_HEIGHT } from '../../constants';
import type { CellMetrics } from '../../utils/cellMetrics';

export type SizeActorEvent =
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }
  | { type: 'STOP_OBSERVE' }
  | { type: 'CONNECTED' }
  | { type: 'REMEASURE' };

export interface SizeActorInput {
  parent: AnyActorRef;
}

/**
 * Measures the terminal font inside `host` (the observed pane container once
 * it exists, `document.body` before that) — see utils/cellMetrics.ts.
 */
export interface MeasureFn {
  (host?: HTMLElement): CellMetrics;
}

const RESIZE_DEBOUNCE_MS = 100;

export function createSizeActor(measureFn: MeasureFn) {
  return fromCallback<SizeActorEvent, SizeActorInput>(({ input, receive }) => {
    let containerObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastCols = 0;
    let lastRows = 0;

    // Track container dimensions from ResizeObserver
    let containerWidth: number | undefined;
    let containerHeight: number | undefined;
    // The element the grid renders in; measurements happen inside it so any
    // inherited property that changes the advance is part of the measurement.
    let measureHost: HTMLElement | undefined;

    // Measure the cell and send immediately. The snapped width is the grid's
    // charWidth; the gap is the letter-spacing that makes text advance by it.
    let metrics = measureFn();
    const sendCharSize = () => {
      input.parent.send({
        type: 'SET_CHAR_SIZE',
        charWidth: metrics.cellWidth,
        charHeight: CHAR_HEIGHT,
        cellGap: metrics.cellGap,
      });
    };
    sendCharSize();

    // Re-measure; only propagate (and re-derive cols/rows) when the cell changed.
    const remeasure = () => {
      const next = measureFn(measureHost);
      if (next.cellWidth === metrics.cellWidth && next.cellGap === metrics.cellGap) return;
      metrics = next;
      sendCharSize();
      lastCols = 0;
      lastRows = 0;
      updateTargetSize();
    };

    // Re-measure after fonts finish loading (initial measurement may use fallback font)
    document.fonts.ready.then(remeasure);

    // Calculate and send target size using container dimensions if available
    const updateTargetSize = () => {
      const { cols, rows } = calculateTargetSize(
        metrics.cellWidth,
        containerWidth,
        containerHeight,
      );
      if (cols !== lastCols || rows !== lastRows) {
        lastCols = cols;
        lastRows = rows;
        input.parent.send({ type: 'SET_TARGET_SIZE', cols, rows });
      }
    };

    updateTargetSize();

    // Debounced window resize
    const handleResize = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateTargetSize, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener('resize', handleResize);

    receive((event) => {
      if (event.type === 'OBSERVE_CONTAINER') {
        measureHost = event.element;
        remeasure();
        containerObserver?.disconnect();
        containerObserver = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            containerWidth = entry.contentRect.width;
            containerHeight = entry.contentRect.height;
            input.parent.send({
              type: 'SET_CONTAINER_SIZE',
              width: containerWidth,
              height: containerHeight,
            });
            // Recalculate target size when container resizes
            updateTargetSize();
          }
        });
        containerObserver.observe(event.element);
      }
      if (event.type === 'STOP_OBSERVE') {
        containerObserver?.disconnect();
        containerObserver = null;
        measureHost = undefined;
        containerWidth = undefined;
        containerHeight = undefined;
      }
      if (event.type === 'CONNECTED') {
        // Force re-send size on reconnection
        lastCols = 0;
        lastRows = 0;
        updateTargetSize();
      }
      if (event.type === 'REMEASURE') {
        remeasure();
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      containerObserver?.disconnect();
    };
  });
}
