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
 * What does not fit then is the terminal's lower rows, and the one that matters
 * is the cursor's: `useCursorInView` scrolls the clipped terminal so the row
 * being typed on stays on screen, a row of margin below it.
 */

import { type RefObject, useEffect, useLayoutEffect } from 'react';

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
 * Scroll `ref` — a terminal cut short by the space it has — so the cursor's
 * row is in view a row above the bottom edge, with as much as fits of what is
 * above it: in a terminal that is the output the line being typed answers.
 * Runs when the box resizes (a keyboard coming up) and whenever `cursorKey`
 * (where the cursor is) changes. A terminal that fits has nothing to scroll,
 * and stays at its top.
 */
export function useCursorInView(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  cursorKey: string,
): void {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!enabled || !box) return;
    const follow = () => {
      const cursor =
        box.querySelector('.pane-active .terminal-cursor') ?? box.querySelector('.terminal-cursor');
      if (!cursor) return;
      const frame = box.getBoundingClientRect();
      const at = cursor.getBoundingClientRect();
      const bottom = at.bottom - frame.top + box.scrollTop;
      // The browser clamps it to what there is to scroll.
      box.scrollTop = Math.max(0, bottom + at.height - box.clientHeight);
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
  }, [ref, enabled, cursorKey]);
}
