/**
 * The phone layout and the phone's own keyboard.
 *
 * A phone keyboard covers the bottom of the page rather than resizing it (iOS,
 * and Chrome on Android by default): the layout viewport keeps its height and
 * only the visual viewport shrinks. So the app follows the visual viewport: its
 * size and offset go on the root as `--app-height` / `--app-top` (standalone.css
 * pins `#root` to them).
 */

import { type RefObject, useEffect, useLayoutEffect } from 'react';
import { dot, TERMINAL_CURSOR } from '../../infra/dom/terminalDom';

const PHONE_CLASS = 'tmuxy-phone';

/** Pin the app to the visual viewport while `enabled` (the phone layout). */
export function useVisualViewport(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!enabled) return;
    root.classList.add(PHONE_CLASS);
    const update = () => {
      root.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      root.classList.remove(PHONE_CLASS);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, [enabled]);
}

/**
 * Scroll `ref`, a terminal cut short by the space it has, so the cursor's row
 * is in view one row above the bottom edge. Zoomed, `xRef` is the viewport the
 * doubled grid scrolls sideways in, scrolled too when the cursor's column has
 * left it. Runs when the box resizes (a keyboard coming up) and when
 * `cursorKey` changes.
 */
export function useCursorInView(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  cursorKey: string,
  xRef: RefObject<HTMLElement | null> | null = null,
): void {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;
    const follow = () => {
      const cursor =
        box.querySelector(`.pane-active ${dot(TERMINAL_CURSOR)}`) ??
        box.querySelector(dot(TERMINAL_CURSOR));
      if (!cursor) return;
      const frame = box.getBoundingClientRect();
      const at = cursor.getBoundingClientRect();
      const bottom = at.bottom - frame.top + box.scrollTop;
      // The browser clamps it to what there is to scroll.
      box.scrollTop = Math.max(0, bottom + at.height - box.clientHeight);
      const sideways = xRef?.current;
      if (!sideways) return;
      const view = sideways.getBoundingClientRect();
      if (at.left < view.left) sideways.scrollLeft -= view.left - at.left + at.width * 4;
      else if (at.right > view.right) sideways.scrollLeft += at.right - view.right + at.width * 4;
    };
    follow();
    // The cursor's own element moves in the same commit or the next frame.
    const frame = requestAnimationFrame(follow);
    const observer = new ResizeObserver(follow);
    observer.observe(box);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref, enabled, cursorKey, xRef]);
}

/** How much the phone's zoom enlarges the terminal (styles mirror it as `--phone-zoom`). */
export const PHONE_ZOOM = 2;

/**
 * The phone's zoom: when it comes on, scroll the sideways viewport `xRef` and
 * the terminal box `yRef` so the tapped point (client px, or the middle when
 * none) sits in the middle of the view; when it goes off, back to the corner.
 * The scaling itself is the stylesheet's (`.phone-pty.is-zoomed`).
 */
export function usePhoneZoomScroll(
  xRef: RefObject<HTMLElement | null>,
  yRef: RefObject<HTMLElement | null>,
  zoom: { x: number | null; y: number | null } | null,
): void {
  useLayoutEffect(() => {
    const sideways = xRef.current;
    const upright = yRef.current;
    if (!sideways || !upright) return;
    if (!zoom) {
      sideways.scrollTo(0, 0);
      upright.scrollTo(0, 0);
      return;
    }
    const frame = sideways.getBoundingClientRect();
    const box = upright.getBoundingClientRect();
    const x = zoom.x ?? frame.left + frame.width / 2;
    const y = zoom.y ?? box.top + box.height / 2;
    sideways.scrollTo({ left: (x - frame.left) * PHONE_ZOOM - frame.width / 2 });
    upright.scrollTo({ top: (y - frame.top) * PHONE_ZOOM - box.height / 2 });
  }, [xRef, yRef, zoom]);
}
