/**
 * Gesture Actor - turns trackpad slides and pinches into GESTURE_* events.
 *
 * A trackpad reaches a web page in two dialects:
 *  - Chromium and Firefox report a pinch as `wheel` events with `ctrlKey` set
 *    (a negative deltaY spreads the fingers). WebKit - Safari and the desktop
 *    app's WKWebView - reports it as `gesturestart` / `gesturechange` /
 *    `gestureend` carrying the cumulative `scale`.
 *  - Both report a two-finger horizontal slide as `wheel` events with deltaX.
 *
 * Neither says when the fingers lift. A pinch ends on `gestureend`, or once the
 * ctrl-wheel stream goes quiet. A slide ends when its stream goes quiet or when
 * its steps start shrinking the way the momentum macOS adds after lift-off
 * does, so the tab switch lands at lift-off like the native gesture instead of
 * after the coast.
 *
 * The listeners sit on the window in the capture phase, ahead of the panes'
 * own wheel handlers, and swallow exactly the events a gesture claims. Vertical
 * scrolling passes through untouched, and a gesture the config turns off
 * claims nothing, which hands it back to the browser - the flags are read off
 * the machine at the moment each event arrives, since the claim has to be made
 * before the event goes anywhere else.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import type { GestureFlags } from '../types';

export type GestureActorEvent = { type: 'NOOP' };

const ALL_ON: GestureFlags = { swipeTabs: true, pinchZoom: true, pinchOverview: true };

interface GestureActorInput {
  parent: AnyActorRef;
}

/** Wheel silence that means a slide's fingers have lifted. */
export const SWIPE_IDLE_MS = 70;
/** How much of the speed estimate each step carries (the rest is the steps before it). */
const SPEED_SMOOTHING = 0.6;
/** Pinch deltas arrive further apart than a slide's; a pause this long ends it. */
export const PINCH_IDLE_MS = 200;
/** A ctrl-wheel step scales by exp(-deltaY / this). */
const PINCH_DELTA_SCALE = 100;
/** A mouse wheel notch is ~100px; capped so Ctrl+wheel on a mouse steps gently. */
const PINCH_MAX_STEP = 25;
/** How much the horizontal axis has to dominate for a slide to start. */
const SWIPE_AXIS_RATIO = 1.5;
/** A vertical scroll this recent keeps a slide from starting mid-scroll. */
const SCROLL_GUARD_MS = 200;
/** After a slide ends, the momentum tail must not start another one. */
export const SWIPE_COOLDOWN_MS = 350;
/** A step in the coast this much bigger than the coast's own steps is the fingers back on the pad. */
const SWIPE_RESTART_RATIO = 1.4;
/** ...and at least this big, so noise in a slow coast cannot restart a slide. */
const SWIPE_RESTART_STEP = 6;
/** Consecutive shrinking steps, below this share of the peak, that read as momentum. */
const MOMENTUM_STEPS = 3;
const MOMENTUM_SHARE = 0.6;

interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** The tiled pane under the fingers, by the element the event landed on. */
function paneIdAt(target: EventTarget | null, x: number, y: number): string | null {
  const el = target instanceof Element ? target : document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>('.pane-layout-item[data-pane-id]')?.dataset.paneId ?? null;
}

export function createGestureActor() {
  return fromCallback<GestureActorEvent, GestureActorInput>(({ input }) => {
    const send = (event: object) => input.parent.send(event);
    const flags = (): GestureFlags => input.parent.getSnapshot()?.context?.gestureFlags ?? ALL_ON;
    const pinchAllowed = () => {
      const f = flags();
      return f.pinchZoom || f.pinchOverview;
    };

    // ---- pinch ---------------------------------------------------------------
    let pinch: { scale: number; paneId: string | null; timer: number | null } | null = null;
    // WebKit reports the pinch as gesture events; any ctrl-wheel it sends
    // alongside must not count the same fingers twice.
    let webkitPinch = false;

    const startPinch = (paneId: string | null) => {
      if (pinch?.timer != null) clearTimeout(pinch.timer);
      pinch = { scale: 1, paneId, timer: null };
      return pinch;
    };
    const endPinch = () => {
      if (!pinch) return;
      if (pinch.timer != null) clearTimeout(pinch.timer);
      pinch = null;
      send({ type: 'GESTURE_PINCH_END' });
    };

    // ---- slide ---------------------------------------------------------------
    let swipe: {
      dx: number;
      peak: number;
      prev: number;
      shrinking: number;
      /** Signed px/ms, smoothed over the last steps. */
      speed: number;
      /** The smoothed speed from while the fingers were still driving the slide - what a release carries on at, before the momentum tail decays it. */
      liftSpeed: number;
      at: number;
      timer: number | null;
    } | null = null;
    let lastVerticalAt = -Infinity;
    let cooldownUntil = -Infinity;
    /** The size of the steps the last slide's coast is arriving in. */
    let coastStep = 0;

    const endSwipe = () => {
      if (!swipe) return;
      if (swipe.timer != null) clearTimeout(swipe.timer);
      const speed = swipe.liftSpeed;
      swipe = null;
      coastStep = 0;
      cooldownUntil = performance.now() + SWIPE_COOLDOWN_MS;
      send({ type: 'GESTURE_SWIPE_END', speed });
    };

    const claim = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        if (webkitPinch) return claim(e);
        if (!pinchAllowed()) return;
        claim(e);
        const p = pinch ?? startPinch(paneIdAt(e.target, e.clientX, e.clientY));
        const step = Math.max(-PINCH_MAX_STEP, Math.min(PINCH_MAX_STEP, e.deltaY));
        p.scale *= Math.exp(-step / PINCH_DELTA_SCALE);
        if (p.timer != null) clearTimeout(p.timer);
        p.timer = window.setTimeout(endPinch, PINCH_IDLE_MS);
        send({ type: 'GESTURE_PINCH', scale: p.scale, paneId: p.paneId });
        return;
      }

      const now = performance.now();
      if (!swipe) {
        const horizontal =
          Math.abs(e.deltaX) >= 1 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * SWIPE_AXIS_RATIO;
        if (!horizontal) {
          if (e.deltaY !== 0) lastVerticalAt = now;
          return;
        }
        if (!flags().swipeTabs || now - lastVerticalAt < SCROLL_GUARD_MS) return;
        // The coast of the slide that just ended: keep it from turning into a
        // browser history swipe, and don't let it start another slide - unless
        // the fingers are plainly back on the pad, since a coast only ever
        // decays while a new push accelerates. Swiping twice quickly is a
        // thing people do.
        if (now < cooldownUntil) {
          const size = Math.abs(e.deltaX);
          const pushing = size >= SWIPE_RESTART_STEP && size > coastStep * SWIPE_RESTART_RATIO;
          if (!pushing) {
            coastStep = Math.max(size, coastStep * 0.8);
            return claim(e);
          }
          cooldownUntil = -Infinity;
          coastStep = 0;
        }
        swipe = {
          dx: 0,
          peak: 0,
          prev: 0,
          shrinking: 0,
          speed: 0,
          liftSpeed: 0,
          at: now,
          timer: null,
        };
      }

      claim(e);
      // The content follows the fingers: moving them left scrolls right.
      const step = -e.deltaX;
      swipe.dx += step;
      // Smoothed so one long frame (or one tiny step) does not decide how fast
      // the release carries on.
      const dt = Math.max(8, Math.min(64, now - swipe.at));
      swipe.at = now;
      swipe.speed = swipe.speed * (1 - SPEED_SMOOTHING) + (step / dt) * SPEED_SMOOTHING;
      const size = Math.abs(step);
      if (size >= Math.abs(swipe.peak)) {
        swipe.peak = step;
        swipe.shrinking = 0;
      } else if (size < Math.abs(swipe.prev)) {
        swipe.shrinking++;
      } else {
        swipe.shrinking = 0;
      }
      swipe.prev = step;
      // Steps that are not already decaying are the fingers themselves.
      if (swipe.shrinking === 0) swipe.liftSpeed = swipe.speed;
      if (swipe.timer != null) clearTimeout(swipe.timer);
      send({ type: 'GESTURE_SWIPE', dx: swipe.dx });

      if (swipe.shrinking >= MOMENTUM_STEPS && size < Math.abs(swipe.peak) * MOMENTUM_SHARE) {
        endSwipe();
        return;
      }
      swipe.timer = window.setTimeout(endSwipe, SWIPE_IDLE_MS);
    };

    const onGestureStart = (e: Event) => {
      if (!pinchAllowed()) return;
      claim(e);
      const g = e as WebKitGestureEvent;
      webkitPinch = true;
      startPinch(paneIdAt(e.target, g.clientX, g.clientY));
    };
    const onGestureChange = (e: Event) => {
      if (!webkitPinch || !pinch) return;
      claim(e);
      pinch.scale = (e as WebKitGestureEvent).scale;
      send({ type: 'GESTURE_PINCH', scale: pinch.scale, paneId: pinch.paneId });
    };
    const onGestureEnd = (e: Event) => {
      if (!webkitPinch) return;
      claim(e);
      webkitPinch = false;
      endPinch();
    };

    // Switching apps mid-gesture never delivers its end.
    const abandon = () => {
      webkitPinch = false;
      endPinch();
      endSwipe();
    };

    const opts = { capture: true, passive: false } as const;
    window.addEventListener('wheel', onWheel, opts);
    window.addEventListener('gesturestart', onGestureStart, opts);
    window.addEventListener('gesturechange', onGestureChange, opts);
    window.addEventListener('gestureend', onGestureEnd, opts);
    window.addEventListener('blur', abandon);

    return () => {
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('gesturestart', onGestureStart, opts);
      window.removeEventListener('gesturechange', onGestureChange, opts);
      window.removeEventListener('gestureend', onGestureEnd, opts);
      window.removeEventListener('blur', abandon);
      if (pinch?.timer != null) clearTimeout(pinch.timer);
      if (swipe?.timer != null) clearTimeout(swipe.timer);
    };
  });
}
