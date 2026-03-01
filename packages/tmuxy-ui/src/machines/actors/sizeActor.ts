/**
 * Size Actor - Manages window resize and container size observation
 *
 * Factory pattern: createSizeActor(measureFn) => fromCallback(...)
 * Replaces useWindowResize + useContainerSize hooks.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import { calculateTargetSize } from '../../utils/layout';
import { CHAR_HEIGHT } from '../../constants';

export type SizeActorEvent =
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }
  | { type: 'STOP_OBSERVE' }
  | { type: 'CONNECTED' };

export interface SizeActorInput {
  parent: AnyActorRef;
}

export interface MeasureFn {
  (): number; // returns charWidth
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

    // Measure char size and send immediately
    const charWidth = measureFn();
    input.parent.send({ type: 'SET_CHAR_SIZE', charWidth, charHeight: CHAR_HEIGHT });

    // Calculate and send target size using container dimensions if available
    const updateTargetSize = () => {
      const { cols, rows } = calculateTargetSize(charWidth, containerWidth, containerHeight);
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
        containerWidth = undefined;
        containerHeight = undefined;
      }
      if (event.type === 'CONNECTED') {
        // Force re-send size on reconnection
        lastCols = 0;
        lastRows = 0;
        updateTargetSize();
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      containerObserver?.disconnect();
    };
  });
}
