/**
 * GestureStage - draws a trackpad gesture in progress onto the pane area.
 *
 * A gesture changes on every wheel or gesture event, up to once a frame, and
 * each step has to cost next to nothing or the grid trails the fingers. So
 * this component renders nothing visible and writes each step as an inline
 * `transform` (and `transition`) on `.pane-layout`, or on the one pane a pinch
 * grows. `transform` is not inherited and runs on the compositor: a step
 * invalidates no style below the element and re-renders no React tree.
 * PaneLayout re-renders only when the shape of the gesture changes - which tab
 * is being pulled in, which pane a pinch acts on - never per step.
 *
 * Every step also nudges the cursor overlay, which otherwise only re-measures
 * when a pane renders, so the cursor rides along with the panes.
 */

import { useLayoutEffect, useRef } from 'react';
import { useAppSelector, selectContainerSize, selectGesture } from '../machines/AppContext';
import { nudgeCursorAnchor } from './cursorAnchor';
import {
  SWIPE_EASING,
  boxTransform,
  enterTransform,
  gestureStageMode,
  gridGestureTransform,
  pinchOutProgress,
  scaledBox,
  zoomGrowBox,
  type Box,
} from '../utils/gestures';
import { clearZoomHandoff, holdZoomHandoff } from '../utils/zoomHandoff';

const offsetBox = (el: HTMLElement): Box => ({
  left: el.offsetLeft,
  top: el.offsetTop,
  width: el.offsetWidth,
  height: el.offsetHeight,
});

/** A pinched pane, its box and the tiled grid's box, in the layout's own coordinates. */
function measurePinch(layout: HTMLElement, paneId: string) {
  const node = layout.querySelector<HTMLElement>(
    `:scope > .pane-layout-item[data-pane-id="${paneId}"]`,
  );
  if (!node) return null;
  const tiled = [
    ...layout.querySelectorAll<HTMLElement>(
      ':scope > .pane-layout-item:not(.pane-window-hidden):not(.pane-swipe-neighbor)',
    ),
  ].map(offsetBox);
  const left = Math.min(...tiled.map((b) => b.left));
  const top = Math.min(...tiled.map((b) => b.top));
  const right = Math.max(...tiled.map((b) => b.left + b.width));
  const bottom = Math.max(...tiled.map((b) => b.top + b.height));
  return {
    paneId,
    node,
    pane: offsetBox(node),
    grid: { left, top, width: right - left, height: bottom - top },
  };
}

/** Where the grid is drawn right now, mid-transition and all. */
function liveTranslateX(el: HTMLElement): number {
  try {
    return new DOMMatrixReadOnly(getComputedStyle(el).transform).m41 || 0;
  } catch {
    return 0;
  }
}

/** One of the FLIP numbers the Tab Overview keeps on the container. */
function overviewNumber(container: HTMLElement, name: string, fallback: number): number {
  const value = parseFloat(container.style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function GestureStage() {
  const gesture = useAppSelector(selectGesture);
  const { width, height } = useAppSelector(selectContainerSize);
  const markerRef = useRef<HTMLSpanElement>(null);
  // Measured once per pinch: the layout does not move under the fingers.
  const measuredRef = useRef<ReturnType<typeof measurePinch>>(null);
  // Where the grid was when this slide began. Zero normally; mid-animation
  // when a new slide took over one still sliding home, which it then carries
  // on from instead of snapping away from. Keyed on the phase it came from,
  // so a take-over (finishing -> tracking) is caught as a new slide, not
  // mistaken for the same one continuing.
  const baseRef = useRef(0);
  const basePhaseRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const container = markerRef.current?.parentElement;
    const layout = container?.querySelector<HTMLElement>(':scope > .pane-layout');
    if (!container || !layout) return;

    const swipePhase = gesture?.kind === 'swipe' ? gesture.phase : null;
    if (swipePhase === 'tracking' && basePhaseRef.current !== 'tracking') {
      // A slide beginning under the fingers - from rest, or taking over one
      // still sliding home - starts from wherever the grid is drawn now.
      baseRef.current = liveTranslateX(layout);
    } else if (!swipePhase) {
      baseRef.current = 0;
    }
    basePhaseRef.current = swipePhase;

    const mode = gestureStageMode(gesture);
    const transform =
      gesture?.kind === 'pinch' && gesture.mode === 'enter'
        ? enterTransform(
            overviewNumber(container, '--tab-overview-x', 0),
            overviewNumber(container, '--tab-overview-y', 0),
            overviewNumber(container, '--tab-overview-sx', 1),
            overviewNumber(container, '--tab-overview-sy', 1),
            pinchOutProgress(gesture.scale),
          )
        : gridGestureTransform(gesture, width, height, baseRef.current);
    // Cleared, the grid is back in the stylesheet's hands: its own transition
    // carries it home, or on into the Tab Overview's card. (A finishing slide
    // takes the branch below instead, which needs `transform` unset last.)
    if (!(gesture?.kind === 'swipe' && gesture.phase === 'finishing')) {
      layout.style.transform = transform ?? '';
    }
    const settleMs = gesture?.kind === 'swipe' ? gesture.settleMs : 0;
    if (gesture?.kind === 'swipe' && gesture.phase === 'finishing') {
      // The tab has already switched, and its panes are drawn at rest where
      // they were a frame ago one offset to the side. Put the grid back by
      // that offset with no transition - the same picture, unmoved - force the
      // browser to take it, then run it home. Nothing waits for this: the
      // switch has happened.
      layout.style.transition = 'none';
      layout.style.transform = transform ?? '';
      layout.getBoundingClientRect();
      layout.style.transition = `transform ${settleMs}ms ${SWIPE_EASING}`;
      layout.style.transform = '';
      nudgeCursorAnchor();
      return;
    }
    layout.style.transition =
      mode === 'settling' ? `transform ${settleMs}ms ${SWIPE_EASING}` : mode ? 'none' : '';

    const pinch =
      gesture?.kind === 'pinch' && (gesture.mode === 'zoom' || gesture.mode === 'unzoom')
        ? gesture
        : null;
    if (!pinch) {
      measuredRef.current = null;
      clearZoomHandoff();
    } else {
      if (measuredRef.current?.paneId !== pinch.paneId) {
        measuredRef.current = measurePinch(layout, pinch.paneId);
      }
      const m = measuredRef.current;
      if (m && pinch.mode === 'zoom') {
        const box = zoomGrowBox(m.pane, m.grid, pinch.scale);
        // The pane is PaneLayout's, but while a pinch holds it React renders
        // no transform of its own, so this one stands until the zoom lands.
        m.node.style.transform = boxTransform(m.pane, box);
        if (pinch.phase === 'handoff') holdZoomHandoff(pinch.paneId, box);
      } else if (m && pinch.phase === 'handoff') {
        holdZoomHandoff(pinch.paneId, scaledBox(m.pane, pinch.scale, width, height));
      }
    }

    nudgeCursorAnchor();
  }, [gesture, width, height]);

  return <span ref={markerRef} hidden />;
}
