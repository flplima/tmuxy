/**
 * The mechanics every floating surface shares: where it goes, how long it
 * stays, and who else has to go away first.
 *
 * Pulled out of TabPreview, which had all three woven into one component while
 * the menus — the same object, wanting the same behaviour — got theirs from a
 * library with its own placement, its own portal and its own transitions. Both
 * are built on this now (`Menu.tsx` adds what makes a surface a MENU), so
 * there is one answer to each question rather than two that disagree.
 *
 * The positioning and the exit hold are the fiddly parts: a card that unmounts
 * the instant its state goes false has no exit animation to play, and one that
 * clamps to the window without measuring itself hangs off the edge for the tabs
 * at either end.
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
 * How long every floating surface takes to come and go.
 *
 * One number for the preview and the menus: they are the same kind of object,
 * and a menu that appears instantly where a card faded reads as two different
 * mechanisms. Must stay in sync with the keyframes in `FloatingSurface.css` —
 * the node is held exactly this long so the exit has something to play on.
 */
export const SURFACE_EXIT_MS = 150;

/** Which side of its anchor a surface hangs on, and how it lines up. */
export interface SurfacePlacement {
  /** `below` for a menu or a preview, `right` for a submenu beside its item. */
  side?: 'below' | 'right';
  /**
   * Across the anchor: `center` ties a picture to the thing it is of, `start`
   * lines a menu's left edge up with its button the way a menu bar does.
   */
  align?: 'center' | 'start';
}

/**
 * Place `surface` against `anchor`, kept inside the viewport.
 *
 * Measures the surface rather than assuming a size: the clamp has to know how
 * wide the thing being clamped actually is, or a card anchored to the last tab
 * in the strip is pulled back by the wrong amount and still overhangs.
 *
 * Flips above the anchor when there is no room below — a menu opened near the
 * bottom of the window otherwise runs off it, and a menu you have to scroll to
 * is a menu you cannot use. The same flip on the other axis is what keeps a
 * submenu on screen at the right-hand edge.
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

  // Beside its anchor rather than under it: a submenu. It opens away from the
  // edge it would otherwise run off, so the last column of a menu chain folds
  // back to the left instead of hanging outside the window.
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
    // Centred on what it belongs to, which is what makes the tie between the
    // two read without a pointer or a line; a menu instead lines its left edge
    // up with its button, which is where the eye already is.
    preferredLeft =
      placement.align === 'start' ? rect.left : rect.left + rect.width / 2 - box.width / 2;
    below = rect.bottom + GAP_PX;
    above = rect.top - GAP_PX;
  }

  const fitsBelow = below + box.height + EDGE_PX <= window.innerHeight;
  place(clampLeft(preferredLeft), fitsBelow ? below : Math.max(EDGE_PX, above - box.height));
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
  /** Which side of the anchor, and how it lines up across it. */
  placement?: SurfacePlacement;
  /**
   * Whether this surface holds the floating layer (`surfaceRegistry`).
   *
   * A top-level surface does: opening it puts away whatever else was open. A
   * submenu does NOT — it belongs to the menu that opened it, and a child that
   * claimed the layer would dismiss its own parent on the way up.
   */
  claim?: boolean;
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
  placement,
  claim = true,
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

  // `contentKey`, not `content`, drives this — and that is load-bearing.
  //
  // Callers build `content` as an object literal at the call site (a preview
  // passes `{ windowId, label }`), so its IDENTITY changes on every render
  // while its VALUE does not. An effect keyed on the identity that also
  // `setShown(content)` is an infinite loop: render, new object, effect,
  // setState, render. It pegged a core for as long as a surface was open, and
  // it is why two TabPreview stories and the sidebar's context-menu story
  // stopped responding entirely — the main thread never came back, so even
  // reading the DOM from outside hung (`storybook-probe` then sat until its
  // 30-minute timeout).
  //
  // `anchorKey` below exists for exactly this reason on the anchor. This is the
  // same rule applied to the content, so a caller cannot reintroduce the loop
  // by passing a literal — which is the natural way to call this.
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
    const timer = setTimeout(() => setShown(null), animated ? exitMs : 0);
    return () => clearTimeout(timer);
  }, [contentKey, animated, exitMs]);

  // Hold the floating layer for exactly as long as this surface is WANTED, not
  // as long as it is drawn: the tail of an exit animation must not dismiss the
  // surface that replaced it.
  useEffect(() => {
    if (contentKey === null || !claim) return;
    return openSurface(id, () => dismissRef.current());
  }, [contentKey, claim, id]);

  // The anchor is rebuilt every render (it is an object literal at the call
  // site), so it is read through a ref rather than depended on: as a dependency
  // it would re-place the surface on every render, and `reposition` would be a
  // new function each time, re-firing every effect that holds it.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const placementRef = useRef(placement);
  placementRef.current = placement;

  const reposition = useCallback(() => {
    const surface = ref.current;
    if (surface) positionSurface(surface, anchorRef.current, placementRef.current);
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
