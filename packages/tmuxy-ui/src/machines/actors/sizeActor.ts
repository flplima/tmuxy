/**
 * Size Actor - Manages window resize and container size observation
 *
 * Factory pattern: createSizeActor(measureFn) => fromCallback(...)
 * Replaces useWindowResize + useContainerSize hooks.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import { calculateTargetSize } from '../../utils/layout';
import { CHAR_HEIGHT } from '../../constants/layout';
import type { CellMetrics } from '../../utils/cellMetrics';
import {
  PHONE_COLS,
  PHONE_ROWS,
  phoneCell,
  phoneMediaQuery,
  rootFontPx,
} from '../../utils/phoneLayout';

export type SizeActorEvent =
  | { type: 'OBSERVE_CONTAINER'; element: HTMLElement }
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

export interface SizeActorOptions {
  /**
   * Take the phone layout (or not) whatever the media query says — for a
   * story, whose frame is not the viewport the query reads.
   */
  phoneLayout?: boolean;
}

export function createSizeActor(measureFn: MeasureFn, options: SizeActorOptions = {}) {
  return fromCallback<SizeActorEvent, SizeActorInput>(({ input, receive }) => {
    let containerObserver: ResizeObserver | null = null;
    // The app body (sidebar columns + pane grid). Its width is what the
    // docked/overlay decision must read: the pane container's own width already
    // depends on that decision, and deciding from it oscillates.
    let bodyObserver: ResizeObserver | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastCols = 0;
    let lastRows = 0;

    // Track container dimensions from ResizeObserver
    let containerWidth: number | undefined;
    let containerHeight: number | undefined;
    // The element the grid renders in; measurements happen inside it so any
    // inherited property that changes the advance is part of the measurement.
    let measureHost: HTMLElement | undefined;

    // The phone layout (utils/phoneLayout.ts): the cell is whatever fits 80
    // columns across the container, and the window asked for is fixed.
    const query = options.phoneLayout === undefined ? phoneMediaQuery() : null;
    let phone = options.phoneLayout ?? query?.matches ?? false;
    input.parent.send({ type: 'SET_PHONE_LAYOUT', phone });

    // Measure the cell and send immediately. The snapped width is the grid's
    // charWidth; the gap is the letter-spacing that makes text advance by it.
    // On a phone the measurement is the root font's (the container carries the
    // shrunken one), read as an advance per pixel of font size.
    const measure = () => measureFn(phone ? undefined : measureHost);
    let metrics = measureFn();
    let sentCell = '';
    const sendCharSize = () => {
      const cell =
        phone && containerWidth ? phoneCell(containerWidth, metrics.advance / rootFontPx()) : null;
      const event = cell
        ? {
            type: 'SET_CHAR_SIZE' as const,
            charWidth: cell.cellWidth,
            charHeight: cell.rowHeight,
            cellGap: cell.cellGap,
            gridFontSize: cell.fontSize,
          }
        : {
            type: 'SET_CHAR_SIZE' as const,
            charWidth: metrics.cellWidth,
            charHeight: CHAR_HEIGHT,
            cellGap: metrics.cellGap,
          };
      const key = JSON.stringify(event);
      if (key === sentCell) return;
      sentCell = key;
      input.parent.send(event);
    };

    sendCharSize();

    // Re-measure; only propagate (and re-derive cols/rows) when the cell changed.
    const remeasure = () => {
      const next = measure();
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
      const { cols, rows } = phone
        ? { cols: PHONE_COLS, rows: PHONE_ROWS }
        : calculateTargetSize(metrics.cellWidth, containerWidth, containerHeight);
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

    const handlePhoneChange = (e: MediaQueryListEvent) => {
      phone = e.matches;
      input.parent.send({ type: 'SET_PHONE_LAYOUT', phone });
      metrics = measure();
      sendCharSize();
      lastCols = 0;
      lastRows = 0;
      updateTargetSize();
    };
    query?.addEventListener('change', handlePhoneChange);

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
            // Recalculate target size when container resizes; on a phone the
            // width is what the cell is cut from.
            if (phone) sendCharSize();
            updateTargetSize();
          }
        });
        containerObserver.observe(event.element);

        bodyObserver?.disconnect();
        const body = event.element.closest('.app-body') ?? event.element.parentElement;
        if (body) {
          bodyObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) input.parent.send({ type: 'SET_BODY_SIZE', width: entry.contentRect.width });
          });
          bodyObserver.observe(body);
        }
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
      query?.removeEventListener('change', handlePhoneChange);
      if (resizeTimeout) clearTimeout(resizeTimeout);
      containerObserver?.disconnect();
      bodyObserver?.disconnect();
    };
  });
}
