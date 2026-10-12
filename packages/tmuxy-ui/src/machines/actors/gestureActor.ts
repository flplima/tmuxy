/**
 * Gesture Actor - turns the desktop app's trackpad gestures into GESTURE_* events.
 *
 * Desktop only (docs/DESKTOP.md). A web page cannot tell when the fingers
 * leave a trackpad: a two-finger slide reaches it as `wheel` events with no
 * phase, and silence is the only thing that ever says "lifted" - the same
 * silence as fingers resting on the pad. So the slide comes from the native
 * shell, which sees the real phases (`NSEvent.phase` on macOS, GTK's smooth
 * scroll and its stop event on Linux) and calls `window.tmuxyGesture` with
 * them, swallowing those events before the webview scrolls on them.
 *
 * A pinch has phases in the webview itself: WebKit reports it as
 * `gesturestart` / `gesturechange` / `gestureend` carrying the cumulative
 * `scale`. (A ctrl+wheel pinch, the Chromium dialect, is kept for a desktop
 * build on WebKitGTK, where it is how libinput's pinch arrives; it ends when
 * the stream goes quiet.) Those listeners sit on the window in the capture
 * phase and swallow exactly the events a gesture claims; a gesture the config
 * turns off claims nothing, which hands it back to the webview.
 */

import { fromCallback, type AnyActorRef } from 'xstate';
import { invoke } from '@tauri-apps/api/core';
import type { AppMachineContext, GestureFlags } from '../types';
import { isModelPaneId, type PaneId } from '../../domain/ids';
import { isTauri } from '../../utils/platform';

export type GestureActorEvent = { type: 'NOOP' };

const ALL_ON: GestureFlags = { swipeTabs: true, pinchZoom: true, pinchOverview: true };

interface GestureActorInput {
  parent: AnyActorRef;
}

/** Pinch deltas arrive further apart than a slide's; a pause this long ends it. */
export const PINCH_IDLE_MS = 200;
/** A ctrl-wheel step scales by exp(-deltaY / this). */
const PINCH_DELTA_SCALE = 100;
/** A mouse wheel notch is ~100px; capped so Ctrl+wheel on a mouse steps gently. */
const PINCH_MAX_STEP = 25;
/** How much of the speed estimate each step carries (the rest is the steps before it). */
const SPEED_SMOOTHING = 0.6;

/** The phases the native shell reports for a slide (docs/DESKTOP.md § Trackpad gestures). */
export type NativeSlidePhase =
  | 'began'
  | 'changed'
  | 'ended'
  | 'cancelled'
  | 'momentum'
  | 'momentum-ended';

/**
 * What the shell calls, once per native scroll event it claims for a slide:
 * `dx` in points, positive when the fingers move right; `t` the event's own
 * timestamp in seconds, so the speed a release carries on at is measured on
 * the device's clock rather than on the page's.
 */
export type NativeGestureHook = (
  kind: 'slide',
  phase: NativeSlidePhase,
  dx: number,
  dy: number,
  t: number,
) => void;

declare global {
  interface Window {
    tmuxyGesture?: NativeGestureHook;
  }
}

interface WebKitGestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

/** The tiled pane under the fingers, by the element the event landed on. */
function paneIdAt(target: EventTarget | null, x: number, y: number): PaneId | null {
  const el = target instanceof Element ? target : document.elementFromPoint(x, y);
  const id = el?.closest<HTMLElement>('.pane-layout-item[data-pane-id]')?.dataset.paneId;
  return isModelPaneId(id) ? id : null;
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
    let pinch: { scale: number; paneId: PaneId | null; timer: number | null } | null = null;
    // WebKit reports the pinch as gesture events; any ctrl-wheel it sends
    // alongside must not count the same fingers twice.
    let webkitPinch = false;

    const startPinch = (paneId: PaneId | null) => {
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

    const claim = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      if (webkitPinch) return claim(e);
      if (!pinchAllowed()) return;
      claim(e);
      const p = pinch ?? startPinch(paneIdAt(e.target, e.clientX, e.clientY));
      const step = Math.max(-PINCH_MAX_STEP, Math.min(PINCH_MAX_STEP, e.deltaY));
      p.scale *= Math.exp(-step / PINCH_DELTA_SCALE);
      if (p.timer != null) clearTimeout(p.timer);
      p.timer = window.setTimeout(endPinch, PINCH_IDLE_MS);
      send({ type: 'GESTURE_PINCH', scale: p.scale, paneId: p.paneId });
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

    // ---- slide (from the shell) ----------------------------------------------
    // The fingers are on the pad from `began` to `ended` or `cancelled`,
    // however long they rest in between: nothing here is timed. The speed a
    // release carries on at is the smoothed speed of the last steps.
    let slide: { dx: number; speed: number; at: number } | null = null;

    const endSlide = (speed: number) => {
      if (!slide) return;
      slide = null;
      send({ type: 'GESTURE_SWIPE_END', speed });
    };

    const onNative: NativeGestureHook = (kind, phase, dx, _dy, t) => {
      if (kind !== 'slide') return;
      switch (phase) {
        case 'began':
          if (!flags().swipeTabs) return;
          slide = { dx: 0, speed: 0, at: t };
          return;
        case 'changed': {
          if (!slide) {
            if (!flags().swipeTabs) return;
            slide = { dx: 0, speed: 0, at: t };
          }
          slide.dx += dx;
          // Smoothed so one long gap (or one tiny step) does not decide how
          // fast the release carries on. Seconds on the wire, ms here.
          const dt = Math.max(8, Math.min(64, (t - slide.at) * 1000));
          slide.at = t;
          slide.speed = slide.speed * (1 - SPEED_SMOOTHING) + (dx / dt) * SPEED_SMOOTHING;
          send({ type: 'GESTURE_SWIPE', dx: slide.dx });
          return;
        }
        case 'ended':
          endSlide(slide?.speed ?? 0);
          return;
        case 'cancelled':
          endSlide(0);
          return;
        default:
          // The momentum tail after a lift: the shell swallows it so the page
          // does not scroll on it, and the slide has already ended at the lift.
          return;
      }
    };

    // Switching apps mid-gesture never delivers its end.
    const abandon = () => {
      webkitPinch = false;
      endPinch();
      endSlide(0);
    };

    // The shell claims a slide's scroll events before the page sees them, so
    // it has to be told when not to: the config flag off. A mouse-tracking
    // program on the tab does NOT turn it off — Claude Code and nvim track
    // the mouse, so gating on them left most tabs with no slide at all, and
    // what a TUI loses is only a horizontal two-finger scroll.
    let shellClaims: boolean | null = null;
    const tellShell = () => {
      const context = input.parent.getSnapshot()?.context as AppMachineContext | undefined;
      if (!context) return;
      const claims = context.gestureFlags.swipeTabs;
      if (claims === shellClaims) return;
      shellClaims = claims;
      if (!isTauri()) return;
      invoke('set_swipe_tabs', { enabled: claims }).catch((e: unknown) =>
        console.error('set_swipe_tabs failed:', e),
      );
    };
    const subscription = input.parent.subscribe(tellShell);
    tellShell();

    const opts = { capture: true, passive: false } as const;
    window.addEventListener('wheel', onWheel, opts);
    window.addEventListener('gesturestart', onGestureStart, opts);
    window.addEventListener('gesturechange', onGestureChange, opts);
    window.addEventListener('gestureend', onGestureEnd, opts);
    window.addEventListener('blur', abandon);
    window.tmuxyGesture = onNative;

    return () => {
      window.removeEventListener('wheel', onWheel, opts);
      window.removeEventListener('gesturestart', onGestureStart, opts);
      window.removeEventListener('gesturechange', onGestureChange, opts);
      window.removeEventListener('gestureend', onGestureEnd, opts);
      window.removeEventListener('blur', abandon);
      subscription.unsubscribe();
      if (window.tmuxyGesture === onNative) delete window.tmuxyGesture;
      if (pinch?.timer != null) clearTimeout(pinch.timer);
    };
  });
}
