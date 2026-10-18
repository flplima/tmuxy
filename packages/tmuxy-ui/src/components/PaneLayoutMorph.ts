/**
 * PaneLayoutMorph — split & kill morph lifecycle detection, FLIP rewind, and
 * cleanup effects for PaneLayout.
 */

import { useEffect, useLayoutEffect, useMemo } from 'react';
import {
  computePaneBox,
  PANE_ENTER_MS,
  PANE_LEAVE_MS,
  PANE_ENTER_FROM_OPACITY,
  type PaneBox,
} from '../constants/layout';
import { findEnterFromBox } from '../utils/paneTransitions';
import { parseSwipeNeighbor } from '../utils/gestures';
import type { TmuxPane } from '../domain/client';

export function useRenderedPanesAndView({
  visiblePanes,
  hiddenWindowPanes,
  paneKeyOverrides,
  zoomedPaneId,
  swipeNeighbor,
  charWidth,
  charHeight,
  centeringOffset,
}: {
  visiblePanes: readonly TmuxPane[];
  hiddenWindowPanes: readonly TmuxPane[];
  paneKeyOverrides: Readonly<Record<string, string>>;
  zoomedPaneId: string | null;
  swipeNeighbor: string | null;
  charWidth: number;
  charHeight: number;
  centeringOffset: { x: number; y: number };
}) {
  // Merge visible + hidden panes into one stable-ordered list so React
  // reconciles by key across tab switches — the new window's <TerminalPane>
  // instances are already mounted (just hidden), so flipping tabs is a CSS
  // class swap, not an unmount/remount. Sort by the effective React key
  // (paneKeyOverrides honored so placeholder→real transitions stay stable).
  const renderedPanes = useMemo(() => {
    const items: {
      pane: TmuxPane;
      hidden: boolean;
      zoomCollapsed: boolean;
      /** Which side a slide is pulling this pane's tab in from (0: not pulled in). */
      swipeSide: number;
    }[] = [];
    for (const pane of visiblePanes) {
      // Zoom-collapsed rather than dropped: the pane keeps its DOM and terminal
      // state (so unzoom restores it instantly and it stays interactive) and,
      // unlike a window-hidden pane, is RENDERED — scaled toward the centre and
      // faded out — so zoom in/out animates instead of hard-cutting.
      const hiddenByZoom = zoomedPaneId !== null && pane.tmuxId !== zoomedPaneId;
      items.push({ pane, hidden: hiddenByZoom, zoomCollapsed: hiddenByZoom, swipeSide: 0 });
    }
    // The tab a slide is pulling in is drawn with its real panes - already
    // mounted, just hidden - so it lines up exactly with the tab it replaces.
    const [neighborId, side] = parseSwipeNeighbor(swipeNeighbor);
    for (const pane of hiddenWindowPanes) {
      const pulledIn = pane.windowId === neighborId;
      items.push({ pane, hidden: !pulledIn, zoomCollapsed: false, swipeSide: pulledIn ? side : 0 });
    }
    items.sort((a, b) => {
      const ka = paneKeyOverrides[a.pane.tmuxId] ?? a.pane.tmuxId;
      const kb = paneKeyOverrides[b.pane.tmuxId] ?? b.pane.tmuxId;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return items;
  }, [visiblePanes, hiddenWindowPanes, paneKeyOverrides, zoomedPaneId, swipeNeighbor]);

  const currView = useMemo(() => {
    const view = new Map<string, RenderedPaneView>();
    for (const { pane, hidden } of renderedPanes) {
      const key = paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId;
      view.set(key, {
        pane,
        hidden,
        box: hidden
          ? null
          : computePaneBox(pane, charWidth, charHeight, centeringOffset.x, centeringOffset.y),
      });
    }
    return view;
  }, [renderedPanes, paneKeyOverrides, charWidth, charHeight, centeringOffset]);

  return { renderedPanes, currView };
}

// One rendered pane as seen by the enter/leave/shift lifecycle: its data,
// visibility, and pixel box (null while hidden — hidden panes have no
// geometry). Keyed by the pane's effective React key (paneKeyOverrides
// honored) so the optimistic placeholder→real-id morph reads as the SAME
// pane and never re-triggers an enter animation.
export interface RenderedPaneView {
  pane: TmuxPane;
  hidden: boolean;
  box: PaneBox | null;
}

export interface EnterAnim {
  fromBox: PaneBox;
  flipped: boolean;
  startedAt: number;
  timer?: number;
  unlisten?: () => void;
}

export interface ShiftAnim {
  timer?: number;
  unlisten?: () => void;
}

/**
 * A pane that has just gone. Nothing of it is drawn — it disappears on the
 * commit that dropped it — but the entry stays for PANE_LEAVE_MS to hold the
 * shift lifecycle open, which is what makes the surviving panes GROW into the
 * space instead of snapping into it.
 */
export interface LeaveAnim {
  pane: TmuxPane;
  timer?: number;
}

export interface RenderItem {
  key: string;
  pane: TmuxPane;
  hidden: boolean;
  zoomCollapsed: boolean;
  swipeSide: number;
}

// How the JS timers outlive the CSS transition, so the lifecycle class is
// never removed while the transition is still running.
export const ANIM_TIMER_SLACK_MS = 40;

// Geometry properties whose `transitionend` on the pane itself marks its
// enter/shift morph as finished — the lifecycle class comes off on that
// event, not on a clock: under load the transition can start late, and a
// class dropped mid-flight leaves the panes overlapping for the next paint.
export const MORPH_PROPERTIES = new Set(['left', 'top', 'width', 'height']);
// Fallback for a morph that never transitions (from- and to-box coincide, or
// animations are disabled): long enough that a running transition always
// ends first, short enough to be invisible — the class only sets timings.
export const MORPH_FALLBACK_MS = PANE_ENTER_MS * 4;

// A pane that disappears this soon after entering is a transient (e.g. the
// intermediate split of a CLI float-create) — drop it instantly instead of
// running a leave morph for a pane the user never meant to see.
const TRANSIENT_PANE_MS = 300;

/** Call `done` once when `node`'s own geometry transition ends; returns the unsubscribe. */
export function onMorphEnd(node: HTMLElement, done: () => void): () => void {
  const handler = (e: TransitionEvent) => {
    if (e.target !== node || !MORPH_PROPERTIES.has(e.propertyName)) return;
    node.removeEventListener('transitionend', handler);
    done();
  };
  node.addEventListener('transitionend', handler);
  return () => node.removeEventListener('transitionend', handler);
}

interface DetectPaneLifecycleArgs {
  lifecycleEnabled: boolean;
  prevView: Map<string, RenderedPaneView> | null;
  currView: Map<string, RenderedPaneView>;
  zoomedPaneId: string | null;
  prevZoomedRef: React.MutableRefObject<string | null>;
  zoomExpandRef: React.MutableRefObject<{ keys: Set<string>; timer?: number } | null>;
  paneKeyOverrides: Readonly<Record<string, string>>;
  allPanes: readonly TmuxPane[];
  prevAllPaneIdsRef: React.MutableRefObject<Set<string>>;
  enterAnimsRef: React.MutableRefObject<Map<string, EnterAnim>>;
  shiftAnimsRef: React.MutableRefObject<Map<string, ShiftAnim>>;
  leavingRef: React.MutableRefObject<Map<string, LeaveAnim>>;
  draggedPaneId: string | null;
  groupSwitchPanes: ReadonlySet<string> | null;
}

export function detectPaneLifecycle({
  lifecycleEnabled,
  prevView,
  currView,
  zoomedPaneId,
  prevZoomedRef,
  zoomExpandRef,
  paneKeyOverrides,
  allPanes,
  prevAllPaneIdsRef,
  enterAnimsRef,
  shiftAnimsRef,
  leavingRef,
  draggedPaneId,
  groupSwitchPanes,
}: DetectPaneLifecycleArgs): void {
  if (!lifecycleEnabled && leavingRef.current.size > 0) {
    // Window switch / drag / animations-off: the growth these were holding
    // open belongs to a layout that no longer exists — drop them instantly.
    for (const l of leavingRef.current.values()) {
      if (l.timer !== undefined) clearTimeout(l.timer);
    }
    leavingRef.current.clear();
  }

  if (lifecycleEnabled && prevView) {
    const prevBoxes = new Map<string, PaneBox>();
    for (const [key, v] of prevView) if (!v.hidden && v.box) prevBoxes.set(key, v.box);
    const currBoxes = new Map<string, PaneBox>();
    for (const [key, v] of currView) if (!v.hidden && v.box) currBoxes.set(key, v.box);

    // Zoom transition. The zooming pane's own grow/shrink is animated by the
    // zoom MutationObserver, from the geometry the DOM actually had; this only
    // tags the siblings.
    if (zoomedPaneId !== prevZoomedRef.current) {
      const zoomingIn = zoomedPaneId !== null;
      const changedId = zoomedPaneId ?? prevZoomedRef.current;
      const changedKey = changedId ? (paneKeyOverrides[changedId] ?? changedId) : undefined;
      // Zoom-out: the siblings (everything but the shrinking pane) expand back
      // out of the centre. Tag them so a gated transition survives the
      // suppression class the unzoom sets.
      if (!zoomingIn) {
        const keys = new Set<string>();
        for (const key of currBoxes.keys()) if (key !== changedKey) keys.add(key);
        zoomExpandRef.current = keys.size > 0 ? { keys } : null;
      }
    }

    // A key appearing in / vanishing from the render list is NOT enough:
    // group siblings and float panes are excluded from renderedPanes while
    // still alive in the model, so a group switch or float create/close
    // moves keys in and out of the render without any pane being born or
    // dying. Only morph panes that are genuinely new to (enter) or gone
    // from (leave) the model.
    const allPaneIds = new Set<string>();
    for (const p of allPanes) allPaneIds.add(p.tmuxId);
    const prevAllPaneIds = prevAllPaneIdsRef.current;

    // Enters: new visible key → FLIP from the split source's pre-split box
    // (fallback: fade in place when nothing plausibly shrank for it).
    for (const [key, v] of currView) {
      if (v.hidden || !v.box || prevView.has(key) || enterAnimsRef.current.has(key)) continue;
      const leave = leavingRef.current.get(key);
      if (leave) {
        // Kill rollback: the pane came back mid-exit — cancel the leave.
        if (leave.timer !== undefined) clearTimeout(leave.timer);
        leavingRef.current.delete(key);
        continue;
      }
      if (prevAllPaneIds.has(v.pane.tmuxId)) continue; // moved, not born
      enterAnimsRef.current.set(key, {
        fromBox: findEnterFromBox(v.box, prevBoxes, currBoxes) ?? v.box,
        flipped: false,
        startedAt: performance.now(),
      });
    }

    // Leaves: previously-visible key gone from the render entirely. A key
    // that merely went hidden (break-pane, hidden windows) stays in
    // currView and never triggers this; a pane that moved into a group
    // slot or float is caught by the model-presence check above.
    for (const [key, v] of prevView) {
      if (currView.has(key) || v.hidden || !v.box || leavingRef.current.has(key)) continue;
      if (allPaneIds.has(v.pane.tmuxId)) continue; // moved, not dead
      const enter = enterAnimsRef.current.get(key);
      if (enter && performance.now() - enter.startedAt < TRANSIENT_PANE_MS) continue;
      leavingRef.current.set(key, { pane: v.pane });
    }

    // Shifts: while any enter/leave is in flight, pre-existing panes whose
    // box changed must animate on the enter clock (not the generic 100ms
    // layout transition) so the converging edges track.
    if (enterAnimsRef.current.size > 0 || leavingRef.current.size > 0) {
      for (const [key, v] of currView) {
        if (v.hidden || !v.box) continue;
        if (enterAnimsRef.current.has(key) || shiftAnimsRef.current.has(key)) continue;
        if (v.pane.tmuxId === draggedPaneId) continue;
        if (groupSwitchPanes?.has(v.pane.tmuxId)) continue;
        const prev = prevView.get(key);
        if (!prev || prev.hidden || !prev.box) continue;
        const b = v.box;
        const p = prev.box;
        if (p.left !== b.left || p.top !== b.top || p.width !== b.width || p.height !== b.height) {
          shiftAnimsRef.current.set(key, {});
        }
      }
    }
  }
}

interface UsePaneMorphCommitArgs {
  containerRef: React.RefObject<HTMLDivElement | null>;
  currView: Map<string, RenderedPaneView>;
  zoomedPaneId: string | null;
  activeWindowId: string | null;
  allPanes: readonly TmuxPane[];
  enterAnimsRef: React.MutableRefObject<Map<string, EnterAnim>>;
  shiftAnimsRef: React.MutableRefObject<Map<string, ShiftAnim>>;
  leavingRef: React.MutableRefObject<Map<string, LeaveAnim>>;
  zoomExpandRef: React.MutableRefObject<{ keys: Set<string>; timer?: number } | null>;
  prevZoomedRef: React.MutableRefObject<string | null>;
  prevViewRef: React.MutableRefObject<Map<string, RenderedPaneView> | null>;
  prevActiveWindowIdRef: React.MutableRefObject<string | null | undefined>;
  prevAllPaneIdsRef: React.MutableRefObject<Set<string>>;
  bumpAnimTick: () => void;
}

export function usePaneMorphCommit({
  containerRef,
  currView,
  zoomedPaneId,
  activeWindowId,
  allPanes,
  enterAnimsRef,
  shiftAnimsRef,
  leavingRef,
  zoomExpandRef,
  prevZoomedRef,
  prevViewRef,
  prevActiveWindowIdRef,
  prevAllPaneIdsRef,
  bumpAnimTick,
}: UsePaneMorphCommitArgs): void {
  // Post-commit: FLIP freshly-entered panes, arm expiry timers, clean up
  // entries whose panes vanished, and snapshot this render for the next diff.
  useLayoutEffect(() => {
    const container = containerRef.current;

    for (const [key, anim] of enterAnimsRef.current) {
      if (!currView.has(key)) {
        if (anim.timer !== undefined) clearTimeout(anim.timer);
        anim.unlisten?.();
        enterAnimsRef.current.delete(key);
      }
    }
    for (const [key, shift] of shiftAnimsRef.current) {
      if (!currView.has(key)) {
        if (shift.timer !== undefined) clearTimeout(shift.timer);
        shift.unlisten?.();
        shiftAnimsRef.current.delete(key);
      }
    }

    // FLIP: rewind the entering pane to its from-box with transitions off,
    // force a style recalc there, then restore React's own inline values —
    // the .pane-entering transition morphs it into place, and neither
    // endpoint is ever painted un-animated. Restoring React's exact values
    // means a later re-render (e.g. confirm-time geometry correction) just
    // retargets the live transition.
    for (const [key, anim] of enterAnimsRef.current) {
      if (anim.flipped) continue;
      anim.flipped = true;
      const node = container?.querySelector<HTMLElement>(`[data-pane-key="${key}"]`);
      if (node) {
        const saved = {
          left: node.style.left,
          top: node.style.top,
          width: node.style.width,
          height: node.style.height,
        };
        node.style.transition = 'none';
        node.style.left = `${anim.fromBox.left}px`;
        node.style.top = `${anim.fromBox.top}px`;
        node.style.width = `${anim.fromBox.width}px`;
        node.style.height = `${anim.fromBox.height}px`;
        node.style.opacity = `${PANE_ENTER_FROM_OPACITY}`;
        node.getBoundingClientRect();
        node.style.transition = '';
        node.style.left = saved.left;
        node.style.top = saved.top;
        node.style.width = saved.width;
        node.style.height = saved.height;
        node.style.opacity = '';
      }
      const finish = () => {
        anim.unlisten?.();
        if (anim.timer !== undefined) clearTimeout(anim.timer);
        enterAnimsRef.current.delete(key);
        bumpAnimTick();
      };
      if (node) anim.unlisten = onMorphEnd(node, finish);
      anim.timer = window.setTimeout(finish, MORPH_FALLBACK_MS);
    }

    for (const [key, shift] of shiftAnimsRef.current) {
      if (shift.timer !== undefined) continue;
      const finish = () => {
        shift.unlisten?.();
        if (shift.timer !== undefined) clearTimeout(shift.timer);
        shiftAnimsRef.current.delete(key);
        bumpAnimTick();
      };
      const node = container?.querySelector<HTMLElement>(`[data-pane-key="${key}"]`);
      if (node) shift.unlisten = onMorphEnd(node, finish);
      shift.timer = window.setTimeout(finish, MORPH_FALLBACK_MS);
    }

    const ze = zoomExpandRef.current;
    if (ze && ze.timer === undefined) {
      ze.timer = window.setTimeout(() => {
        zoomExpandRef.current = null;
        bumpAnimTick();
      }, PANE_ENTER_MS + ANIM_TIMER_SLACK_MS);
    }
    prevZoomedRef.current = zoomedPaneId;
    for (const [key, leave] of leavingRef.current) {
      if (leave.timer !== undefined) continue;
      leave.timer = window.setTimeout(() => {
        leavingRef.current.delete(key);
        bumpAnimTick();
      }, PANE_LEAVE_MS + ANIM_TIMER_SLACK_MS);
    }

    prevViewRef.current = currView;
    prevActiveWindowIdRef.current = activeWindowId;
    prevAllPaneIdsRef.current = new Set(allPanes.map((p) => p.tmuxId));
  });

  // The Maps themselves are stable instances — capture them once so the
  // unmount cleanup reads their final contents.
  useEffect(() => {
    const enters = enterAnimsRef.current;
    const shifts = shiftAnimsRef.current;
    const leaves = leavingRef.current;
    return () => {
      for (const a of enters.values()) {
        if (a.timer !== undefined) clearTimeout(a.timer);
        a.unlisten?.();
      }
      for (const s of shifts.values()) {
        if (s.timer !== undefined) clearTimeout(s.timer);
        s.unlisten?.();
      }
      for (const l of leaves.values()) if (l.timer !== undefined) clearTimeout(l.timer);
    };
  }, [enterAnimsRef, shiftAnimsRef, leavingRef]);
}
