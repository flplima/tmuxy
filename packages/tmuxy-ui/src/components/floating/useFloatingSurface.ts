import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cssDurationMs } from '../../infra/dom/cssTiming';
import { openSurface } from './surfaceRegistry';

/** Where a surface hangs: under an element, or at a point (a right-click). */
export type SurfaceAnchor =
  | { kind: 'element'; element: HTMLElement | null }
  | { kind: 'point'; x: number; y: number };

const GAP_PX = 6;
/** Closest a surface may come to the window's edge. */
const EDGE_PX = 8;

export interface SurfacePlacement {
  /** `below` for a menu or a preview, `right` for a submenu beside its item. */
  side?: 'below' | 'right';
  /** `center` under the thing it previews; `start` lines a menu's left edge up with its button. */
  align?: 'center' | 'start';
}

/**
 * Place `surface` against `anchor`, inside the viewport: it flips above the
 * anchor when there is no room below, and a submenu flips left at the right edge.
 */
export function positionSurface(
  surface: HTMLElement,
  anchor: SurfaceAnchor,
  placement: SurfacePlacement = {},
): void {
  const box = surface.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return;

  const clampLeft = (left: number) =>
    Math.min(Math.max(EDGE_PX, left), Math.max(EDGE_PX, window.innerWidth - box.width - EDGE_PX));
  const place = (left: number, top: number) => {
    surface.style.left = `${Math.round(left)}px`;
    surface.style.top = `${Math.round(top)}px`;
  };

  if (placement.side === 'right' && anchor.kind === 'element') {
    if (!anchor.element) return;
    const rect = anchor.element.getBoundingClientRect();
    const right = rect.right + GAP_PX;
    const left = right + box.width + EDGE_PX <= window.innerWidth ? right : rect.left - box.width;
    place(
      clampLeft(left),
      Math.max(EDGE_PX, Math.min(rect.top, window.innerHeight - box.height - EDGE_PX)),
    );
    return;
  }

  let preferredLeft: number;
  let below: number;
  let above: number;

  if (anchor.kind === 'point') {
    preferredLeft = anchor.x;
    below = anchor.y;
    above = anchor.y;
  } else {
    if (!anchor.element) return;
    const rect = anchor.element.getBoundingClientRect();
    preferredLeft =
      placement.align === 'start' ? rect.left : rect.left + rect.width / 2 - box.width / 2;
    below = rect.bottom + GAP_PX;
    above = rect.top - GAP_PX;
  }

  const fitsBelow = below + box.height + EDGE_PX <= window.innerHeight;
  place(clampLeft(preferredLeft), fitsBelow ? below : Math.max(EDGE_PX, above - box.height));
}

export function surfacePortalTarget(): HTMLElement {
  return document.querySelector<HTMLElement>('.app-container') ?? document.body;
}

interface FloatingSurfaceOptions<T> {
  /** Identity in the registry. Peers with other ids dismiss each other. */
  id: string;
  content: T | null;
  /** Where it hangs. Re-read on every render, so a moving anchor is followed. */
  anchor: SurfaceAnchor;
  placement?: SurfacePlacement;
  /**
   * Whether this surface holds the floating layer (`surfaceRegistry`); false
   * for a submenu, which would otherwise dismiss its own parent.
   */
  claim?: boolean;
  /** False when the app's animation switch is off — then exits are instant. */
  animated: boolean;
  /** Called when a peer surface opens. */
  onDismiss: () => void;
}

interface FloatingSurfaceResult<T> {
  ref: React.RefObject<HTMLDivElement | null>;
  /** What to DRAW — outlives `content` by the exit duration, then null. */
  shown: T | null;
  leaving: boolean;
  /** Re-place the surface; call after its size changes. */
  reposition: () => void;
}

export function useFloatingSurface<T>({
  id,
  content,
  anchor,
  placement,
  claim = true,
  animated,
  onDismiss,
}: FloatingSurfaceOptions<T>): FloatingSurfaceResult<T> {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState<T | null>(null);
  const [leaving, setLeaving] = useState(false);

  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  // Keyed on `JSON.stringify(content)`, not `content`: callers pass an object
  // literal, whose identity changes every render, and an effect keyed on it that
  // sets state loops forever (it froze the main thread while a surface was open).
  const contentKey = content === null ? null : JSON.stringify(content);
  const contentRef = useRef(content);
  contentRef.current = content;
  useEffect(() => {
    if (contentKey !== null) {
      setShown(contentRef.current);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    // Held for the exit animation: `--transition-normal`, which the keyframes in
    // FloatingSurface.css use.
    const exitMs = animated && ref.current ? cssDurationMs(ref.current, '--transition-normal') : 0;
    const timer = setTimeout(() => setShown(null), exitMs);
    return () => clearTimeout(timer);
  }, [contentKey, animated]);

  useEffect(() => {
    if (contentKey === null || !claim) return;
    return openSurface(id, () => dismissRef.current());
  }, [contentKey, claim, id]);

  // Read through refs for the same reason as `contentKey`: the anchor is a
  // literal rebuilt every render.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const placementRef = useRef(placement);
  placementRef.current = placement;

  const reposition = useCallback(() => {
    const surface = ref.current;
    if (surface) positionSurface(surface, anchorRef.current, placementRef.current);
  }, []);

  const anchorKey =
    anchor.kind === 'point' ? `${anchor.x},${anchor.y}` : (anchor.element?.dataset.windowId ?? '');
  useLayoutEffect(() => {
    if (shown === null) return;
    reposition();
  }, [shown, anchorKey, reposition]);

  return { ref, shown, leaving, reposition };
}
