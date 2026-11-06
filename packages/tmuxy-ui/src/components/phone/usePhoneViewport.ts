/**
 * The phone layout and the phone's own keyboard.
 *
 * A phone keyboard covers the bottom of the page rather than resizing it (iOS,
 * and Chrome on Android by default): the layout viewport keeps its height and
 * only the visual viewport — the part not under the keyboard — shrinks. So the
 * app follows the visual viewport: its size and offset go on the root as
 * `--app-height` / `--app-top` (standalone.css pins `#root` to them), and the
 * page is laid out in what the user can see.
 *
 * Installed on an iPhone with the status bar drawn over the page, iOS reports
 * the visible height — the visual viewport, `innerHeight`, `100dvh` — short by
 * the status bar's height while the page runs to the screen's bottom edge, so
 * the root stopped that far above it and left a blank band at the bottom;
 * `standaloneShortfall` puts the slice back.
 */

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { dot, TERMINAL_CURSOR } from '../../infra/dom/terminalDom';

const PHONE_CLASS = 'tmuxy-phone';
/** On the root while a keyboard covers the page's bottom (the styles make way). */
const KEYBOARD_CLASS = 'tmuxy-keyboard-up';

/** What the page knows of its height in an installed app, in CSS px. */
export interface StandaloneHeights {
  /** Running as an installed app (`display-mode: standalone`). */
  standalone: boolean;
  /** The screen's full height for the page: `100lvh`. */
  large: number;
  /** `window.innerHeight`. */
  inner: number;
  /** The visual viewport's height. */
  visual: number;
  /** `env(safe-area-inset-top)`: the status bar over the page. */
  insetTop: number;
}

/**
 * The height iOS leaves out of what it reports in an installed app whose
 * status bar is drawn over the page: the reported height falls short of the
 * screen's by the status bar's height, exactly. Only with the keyboard down —
 * a keyboard shrinks the visual viewport and nothing else, and what it leaves
 * is laid out as reported. A browser tab, and a keyboard that really resizes
 * the page (Android's), never match.
 */
export function standaloneShortfall(h: StandaloneHeights): number {
  if (!h.standalone || h.insetTop <= 0) return 0;
  if (h.visual < h.inner - 1) return 0;
  const short = h.large - h.inner;
  return Math.abs(short - h.insetTop) <= 2 ? short : 0;
}

/** `100lvh` and the top safe-area inset, read off an invisible probe. */
function measureProbe(): { large: number; insetTop: number } {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;' +
    'height:100vh;height:100lvh;padding-top:env(safe-area-inset-top,0px);box-sizing:content-box';
  document.body.appendChild(probe);
  const insetTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  const large = probe.getBoundingClientRect().height - insetTop;
  probe.remove();
  return { large, insetTop };
}

/** Pin the app to the visual viewport while `enabled` (the phone layout). */
export function useVisualViewport(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!enabled) return;
    root.classList.add(PHONE_CLASS);
    // The screen's height and the status bar's change only on a rotation (a
    // window resize), not on every scroll of the visual viewport.
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
    let full = standalone ? measureProbe() : null;
    const update = () => {
      const visual = viewport?.height ?? window.innerHeight;
      const shortfall = full
        ? standaloneShortfall({ standalone, inner: window.innerHeight, visual, ...full })
        : 0;
      root.style.setProperty('--app-height', `${visual + shortfall}px`);
      // A keyboard shrinks the visual viewport and nothing else.
      root.classList.toggle(KEYBOARD_CLASS, visual < window.innerHeight - 1);
      root.style.setProperty('--app-top', `${viewport?.offsetTop ?? 0}px`);
    };
    const rotated = () => {
      if (standalone) full = measureProbe();
      update();
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', rotated);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', rotated);
      root.classList.remove(PHONE_CLASS, KEYBOARD_CLASS);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-top');
    };
  }, [enabled]);
}

/**
 * Scroll `ref` — a terminal cut short by the space it has (a keyboard up) — so
 * the cursor's row is in view a row above the bottom edge, with as much as
 * fits of the output above it. Zoomed, `xRef` is the doubled grid's sideways
 * viewport, scrolled too when the cursor's column has left it — once the
 * cursor has moved or the box has got shorter, never just because the zoom
 * came on: a double tap zooms around the point tapped (usePhoneZoomScroll),
 * and following the cursor then took the view straight back to it.
 */
export function useCursorInView(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  cursorKey: string,
  xRef: RefObject<HTMLElement | null> | null = null,
): void {
  const lastKey = useRef<string | null>(null);
  const lastHeight = useRef(0);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;
    const moved = lastKey.current !== null && lastKey.current !== cursorKey;
    lastKey.current = cursorKey;
    const follow = () => {
      const shorter = box.clientHeight < lastHeight.current - 1;
      lastHeight.current = box.clientHeight;
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
      if (!sideways || !(moved || shorter)) return;
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
