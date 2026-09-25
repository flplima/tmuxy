/**
 * The mechanics every floating surface shares: where it goes, how long it
 * stays, and who else has to go away first.
 *
 * Pulled out of TabPreview, which had all three woven into one component — so
 * the context menus, which want exactly the same behaviour, each grew their own
 * partial version instead. The positioning and the exit hold are the fiddly
 * parts (a card that unmounts the instant its state goes false has no exit
 * animation to play, and one that clamps to the window without measuring itself
 * hangs off the edge for the tabs at either end).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openSurface } from './surfaceRegistry';

/** Where a surface hangs: under an element, or at a point (a right-click). */
export type SurfaceAnchor =
  | { kind: 'element'; element: HTMLElement | null }
  | { kind: 'point'; x: number; y: number };

/** Distance between the anchor and the surface. */
const GAP_PX = 6;
/** Closest a surface may come to the window's edge. */
const EDGE_PX = 8;

/**
 * Place `surface` against `anchor`, kept inside the viewport.
 *
 * Measures the surface rather than assuming a size: the clamp has to know how
 * wide the thing being clamped actually is, or a card anchored to the last tab
 * in the strip is pulled back by the wrong amount and still overhangs.
 *
 * Flips above the anchor when there is no room below — a menu opened near the
 * bottom of the window otherwise runs off it, and a menu you have to scroll to
 * is a menu you cannot use.
 */
export function positionSurface(surface: HTMLElement, anchor: SurfaceAnchor): void {
  const box = surface.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return;

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
    // Centred on what it belongs to, which is what makes the tie between the
    // two read without a pointer or a line.
    preferredLeft = rect.left + rect.width / 2 - box.width / 2;
    below = rect.bottom + GAP_PX;
    above = rect.top - GAP_PX;
  }

  const left = Math.min(
    Math.max(EDGE_PX, preferredLeft),
    Math.max(EDGE_PX, window.innerWidth - box.width - EDGE_PX),
  );

  const fitsBelow = below + box.height + EDGE_PX <= window.innerHeight;
  const top = fitsBelow ? below : Math.max(EDGE_PX, above - box.height);

  surface.style.left = `${Math.round(left)}px`;
  surface.style.top = `${Math.round(top)}px`;
}

/** The element floating surfaces portal into. */
export function surfacePortalTarget(): HTMLElement {
  return document.querySelector<HTMLElement>('.app-container') ?? document.body;
}

interface FloatingSurfaceOptions<T> {
  /** Identity in the registry. Peers with other ids dismiss each other. */
  id: string;
  /** What the caller wants shown, or null for "nothing". */
  content: T | null;
  /** Where it hangs. Re-read on every render, so a moving anchor is followed. */
  anchor: SurfaceAnchor;
  /** How long the exit animation runs; the node is held exactly that long. */
  exitMs: number;
  /** False when the app's animation switch is off — then exits are instant. */
  animated: boolean;
  /** Put the surface away. Called when a peer surface opens. */
  onDismiss: () => void;
}

interface FloatingSurfaceResult<T> {
  /** Ref for the surface's root element. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** What to DRAW — outlives `content` by the exit duration, then null. */
  shown: T | null;
  /** True while the exit is playing, for the leaving class. */
  leaving: boolean;
  /** Re-place the surface; call after its size changes. */
  reposition: () => void;
}

/**
 * Own a floating surface's lifetime and placement.
 *
 * `shown` is deliberately not `content`: when the caller stops asking for a
 * surface the node has to stay long enough for its exit to play, and a
 * component that renders `content` directly unmounts first and animates never.
 */
export function useFloatingSurface<T>({
  id,
  content,
  anchor,
  exitMs,
  animated,
  onDismiss,
}: FloatingSurfaceOptions<T>): FloatingSurfaceResult<T> {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState<T | null>(null);
  const [leaving, setLeaving] = useState(false);

  // The registry calls this from outside React, so it must always reach the
  // caller's CURRENT dismiss rather than the one from the render that opened.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (content !== null) {
      setShown(content);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const timer = setTimeout(() => setShown(null), animated ? exitMs : 0);
    return () => clearTimeout(timer);
  }, [content, animated, exitMs]);

  // Hold the floating layer for exactly as long as this surface is WANTED, not
  // as long as it is drawn: the tail of an exit animation must not dismiss the
  // surface that replaced it.
  useEffect(() => {
    if (content === null) return;
    return openSurface(id, () => dismissRef.current());
  }, [content, id]);

  // The anchor is rebuilt every render (it is an object literal at the call
  // site), so it is read through a ref rather than depended on: as a dependency
  // it would re-place the surface on every render, and `reposition` would be a
  // new function each time, re-firing every effect that holds it.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const reposition = useCallback(() => {
    const surface = ref.current;
    if (surface) positionSurface(surface, anchorRef.current);
  }, []);

  // Keyed on what actually moves the surface: the thing being shown, and the
  // anchor's own coordinates or element.
  const anchorKey =
    anchor.kind === 'point' ? `${anchor.x},${anchor.y}` : (anchor.element?.dataset.windowId ?? '');
  useLayoutEffect(() => {
    if (shown === null) return;
    reposition();
  }, [shown, anchorKey, reposition]);

  return { ref, shown, leaving, reposition };
}

/**
 * Claim the floating layer for a surface that positions itself.
 *
 * The context menus and the app menu come from `@szhsin/react-menu`, which owns
 * their placement and their portal — so they want the COORDINATION half of a
 * floating surface without the mechanics. Mounting one puts away whatever else
 * was open (a tab preview, another menu), and unmounting releases the layer.
 *
 * `onDismiss` must close the menu at its own source of truth. Without it a peer
 * can take the layer while the menu's own `visible` flag stays true, and the
 * menu sits there owning nothing.
 */
export function useSurfaceClaim(id: string, onDismiss: () => void, open = true): void {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    return openSurface(id, () => dismissRef.current());
  }, [id, open]);
}
