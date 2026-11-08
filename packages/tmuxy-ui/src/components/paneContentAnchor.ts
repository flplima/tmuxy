/**
 * Which edge of a pane its live screen hangs from while the pane's height
 * morphs. The screen is anchored to the bottom edge (keeping the prompt in
 * view), but React commits the new rows with the new box while the CSS
 * transition still draws nearly the old one, so a pane growing downwards drew
 * its taller screen hanging off its top and slid it down. Hanging from the
 * edge that moves less keeps the rows where they will end up.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PaneBox } from '../domain/paneGeometry';
import { morphFallbackMs } from './PaneLayoutMorph';

export type ContentAnchor = 'top' | 'bottom';

/** The anchor for a box going `from` → `to`, or null when its height holds. */
export function contentAnchorFor(from: PaneBox, to: PaneBox): ContentAnchor | null {
  if (from.height === to.height) return null;
  const topMoves = Math.abs(to.top - from.top);
  const bottomMoves = Math.abs(to.top + to.height - (from.top + from.height));
  return topMoves <= bottomMoves ? 'top' : 'bottom';
}

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
      const timer = window.setTimeout(() => release(), morphFallbackMs(node));
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
