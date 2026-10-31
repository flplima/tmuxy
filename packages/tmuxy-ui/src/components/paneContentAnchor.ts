/**
 * Which edge of a pane its live screen hangs from while the pane's height
 * morphs.
 *
 * The live screen is sized to tmux's row count and anchored to the pane's
 * bottom edge, which keeps the prompt in view when the content outgrows the
 * box. A geometry change is a CSS transition, though, and React commits the
 * new rows together with the new box: on the transition's first frames the
 * box is still nearly the old size while the rows are already the new ones.
 * A pane growing downwards then drew its taller screen hanging off its top —
 * a 15-row pane given 30 rows showed rows 15–30, 360px above where they
 * land, and slid them down as the box caught up.
 *
 * The edge that moves less is the one to hang from: for a pane growing
 * downwards that is its top, and its rows then stay where they will end up
 * while the box opens over them. Bottom stays the default, so this only ever
 * applies while the height is in flight.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PaneBox } from '../constants/layout';
import { MORPH_FALLBACK_MS } from './PaneLayoutMorph';

export type ContentAnchor = 'top' | 'bottom';

/** The anchor for a box going `from` → `to`, or null when its height holds. */
export function contentAnchorFor(from: PaneBox, to: PaneBox): ContentAnchor | null {
  if (from.height === to.height) return null;
  const topMoves = Math.abs(to.top - from.top);
  const bottomMoves = Math.abs(to.top + to.height - (from.top + from.height));
  return topMoves <= bottomMoves ? 'top' : 'bottom';
}

/**
 * Sets `data-content-anchor="top"` on a pane whose height changes with its
 * top edge holding, before the commit is painted, and takes it off when that
 * height transition ends.
 */
export function useMorphContentAnchor(
  containerRef: React.RefObject<HTMLElement | null>,
  boxes: ReadonlyMap<string, { box: PaneBox | null }>,
): void {
  const prevRef = useRef(new Map<string, PaneBox>());
  const pendingRef = useRef(new Map<string, () => void>());

  useLayoutEffect(() => {
    const prev = prevRef.current;
    const next = new Map<string, PaneBox>();
    for (const [key, { box }] of boxes) {
      if (!box) continue;
      next.set(key, box);
      const from = prev.get(key);
      const anchor = from ? contentAnchorFor(from, box) : null;
      if (!anchor) continue;
      pendingRef.current.get(key)?.();
      if (anchor === 'bottom') continue;
      const node = containerRef.current?.querySelector<HTMLElement>(`[data-pane-key="${key}"]`);
      if (!node) continue;
      node.dataset.contentAnchor = anchor;
      const onEnd = (e: TransitionEvent) => {
        if (e.target === node && e.propertyName === 'height') release();
      };
      const timer = window.setTimeout(() => release(), MORPH_FALLBACK_MS);
      const release = () => {
        node.removeEventListener('transitionend', onEnd);
        clearTimeout(timer);
        delete node.dataset.contentAnchor;
        pendingRef.current.delete(key);
      };
      node.addEventListener('transitionend', onEnd);
      pendingRef.current.set(key, release);
    }
    prevRef.current = next;
  }, [containerRef, boxes]);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const release of [...pending.values()]) release();
    };
  }, []);
}
