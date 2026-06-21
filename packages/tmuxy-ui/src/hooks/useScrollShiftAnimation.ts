/**
 * useScrollShiftAnimation — a subtle, quick slide when a pane's content scrolls.
 *
 * On every content update it diffs the previous and new visible grids
 * (detectVerticalShift). When the new frame is a confident vertical shift of the
 * old one — copy-mode scroll, `less`/`vim` scroll, a log tail, etc. — it renders
 * the new content at its old position and transitions it to its new one, so the
 * change reads as a scroll rather than a jump. When no shift can be inferred
 * (a full redraw, a big jump from the top of history) it does nothing.
 *
 * This follows the useAnimatedPane precedent: a transient, view-only transform
 * driven imperatively in a layout effect (the accepted exception to the
 * "no useEffect / logic in the state machine" rule). The diff itself lives in a
 * pure, unit-tested function (scrollShift.ts); only the DOM mutation is here.
 *
 * Honors both the caller-provided `enabled` flag (which combines the
 * `@tmuxy-scroll-animation` option with the internal animation-settling gate)
 * and the user's `prefers-reduced-motion` setting.
 */

import { useLayoutEffect, useEffect, useRef, type RefObject } from 'react';
import type { PaneContent } from '../tmux/types';
import { detectVerticalShift } from '../utils/scrollShift';

interface ScrollShiftAnimationOptions {
  /** The pane's current visible content. */
  content: PaneContent;
  /** Whether the animation is enabled (config flag AND settling gate). */
  enabled: boolean;
  /** Terminal line height in pixels. */
  lineHeight: number;
  /** The element to translate — must be a stable node across content updates. */
  targetRef: RefObject<HTMLDivElement | null>;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useScrollShiftAnimation({
  content,
  enabled,
  lineHeight,
  targetRef,
}: ScrollShiftAnimationOptions): void {
  const prevRef = useRef<PaneContent | null>(null);
  const rafRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = content;

    const el = targetRef.current;
    if (!el || !enabled || lineHeight <= 0 || prefersReducedMotion()) return;
    if (!prev) return;

    const k = detectVerticalShift(prev, content);
    if (k === 0) return;

    // Cancel any in-flight slide and snap to its end before starting a new one
    // (rapid scrolls), so transforms never compound.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    // Place the new content where it came from, with no transition, then force a
    // reflow so the start position paints before the transition begins.
    el.style.transition = 'none';
    el.style.transform = `translateY(${-k * lineHeight}px)`;
    void el.offsetHeight;

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      el.style.transition = 'transform var(--scroll-shift-duration, 120ms) ease-out';
      el.style.transform = 'translateY(0)';
      const clear = () => {
        el.style.transition = '';
        el.style.transform = '';
        el.removeEventListener('transitionend', clear);
      };
      el.addEventListener('transitionend', clear, { once: true });
    });
  }, [content, enabled, lineHeight, targetRef]);

  // Cancel a pending frame if the pane unmounts mid-slide.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);
}
