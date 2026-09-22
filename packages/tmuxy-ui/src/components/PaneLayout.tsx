/**
 * PaneLayout renders tmux panes using absolute CSS positioning
 *
 * - Drag by pane header to swap panes (dragged pane follows the cursor)
 * - Resize from dividers between panes
 * - Enter/leave/shift lifecycle: CSS-transition FLIP morphs for pane
 *   split/kill/geometry changes, tracked component-locally via refs and a
 *   tick reducer (see STATE-MANAGEMENT.md "Pane enter/leave animations").
 *   A pane that CLOSES simply goes: what is animated is the space opening up,
 *   i.e. the survivors growing into it.
 * - Events sent to appMachine on mouse actions
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useMemo,
  ReactNode,
} from 'react';
import { ResizeDividers } from './ResizeDividers';
import {
  computePaneBox,
  PANE_ENTER_MS,
  PANE_LEAVE_MS,
  PANE_ENTER_FROM_OPACITY,
  type PaneBox,
} from '../constants';
import { findEnterFromBox } from '../utils/paneTransitions';
import { gridExtent } from '../machines/app/helpers';
import {
  useAppSelector,
  useAppSend,
  useIsDragging,
  useIsResizing,
  selectVisiblePanes,
  selectHiddenWindowPanes,
  selectDraggedPaneId,
  selectDragOffsetX,
  selectDragOffsetY,
  selectGridDimensions,
  selectContainerSize,
  selectSettledPaneWidth,
  selectDropTarget,
  selectEnableAnimations,
  selectSuppressLayoutTransition,
  selectKeyboardElsewhere,
  selectGroupSwitchPaneIds,
  selectPaneKeyOverrides,
  selectSwipeNeighbor,
  selectSwipeStill,
  selectGesturePaneId,
} from '../machines/AppContext';
import type { TmuxPane } from '../machines/types';
import { findZoomedPane } from '../utils/layout';
import { parseSwipeNeighbor, swipeOffsetPx } from '../utils/gestures';
import { takeZoomHandoff } from '../utils/zoomHandoff';

interface PaneLayoutProps {
  children: (pane: TmuxPane) => ReactNode;
}

// One rendered pane as seen by the enter/leave/shift lifecycle: its data,
// visibility, and pixel box (null while hidden — hidden panes have no
// geometry). Keyed by the pane's effective React key (paneKeyOverrides
// honored) so the optimistic placeholder→real-id morph reads as the SAME
// pane and never re-triggers an enter animation.
interface RenderedPaneView {
  pane: TmuxPane;
  hidden: boolean;
  box: PaneBox | null;
}

interface EnterAnim {
  fromBox: PaneBox;
  flipped: boolean;
  startedAt: number;
  timer?: number;
  unlisten?: () => void;
}

interface ShiftAnim {
  timer?: number;
  unlisten?: () => void;
}

/**
 * A pane that has just gone. Nothing of it is drawn — it disappears on the
 * commit that dropped it — but the entry stays for PANE_LEAVE_MS to hold the
 * shift lifecycle open, which is what makes the surviving panes GROW into the
 * space instead of snapping into it.
 */
interface LeaveAnim {
  pane: TmuxPane;
  timer?: number;
}

// How the JS timers outlive the CSS transition, so the lifecycle class is
// never removed while the transition is still running.
const ANIM_TIMER_SLACK_MS = 40;

// Geometry properties whose `transitionend` on the pane itself marks its
// enter/shift morph as finished — the lifecycle class comes off on that
// event, not on a clock: under load the transition can start late, and a
// class dropped mid-flight leaves the panes overlapping for the next paint.
const MORPH_PROPERTIES = new Set(['left', 'top', 'width', 'height']);
// Fallback for a morph that never transitions (from- and to-box coincide, or
// animations are disabled): long enough that a running transition always
// ends first, short enough to be invisible — the class only sets timings.
const MORPH_FALLBACK_MS = PANE_ENTER_MS * 4;

/** Call `done` once when `node`'s own geometry transition ends; returns the unsubscribe. */
function onMorphEnd(node: HTMLElement, done: () => void): () => void {
  const handler = (e: TransitionEvent) => {
    if (e.target !== node || !MORPH_PROPERTIES.has(e.propertyName)) return;
    node.removeEventListener('transitionend', handler);
    done();
  };
  node.addEventListener('transitionend', handler);
  return () => node.removeEventListener('transitionend', handler);
}

/** A pane's `left/top/width/height` from its inline style text; null when it has no box (hidden). */
function styleBox(style: string): PaneBox | null {
  const px = (prop: string) => {
    const m = style.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`));
    return m ? parseFloat(m[1]) : null;
  };
  const left = px('left');
  const top = px('top');
  const width = px('width');
  const height = px('height');
  if (left === null || top === null || width === null || height === null) return null;
  return { left, top, width, height };
}

const ZOOM_FLIP_TRANSITION = [...MORPH_PROPERTIES]
  .map((prop) => `${prop} var(--transition-pane-zoom)`)
  .join(', ');

/**
 * Animate a pane that just got its zoomed (or unzoomed) box from `from`: put
 * it back there with transitions off, force a style recalc, then let its own
 * box morph on the zoom clock. The transition is set inline, so it wins over
 * the suppression classes the zoom's layout change carries, and is dropped
 * again when the morph ends.
 */
function flipZoom(node: HTMLElement, from: PaneBox): void {
  const to = {
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
  };
  node.style.transition = 'none';
  node.style.zIndex = 'var(--z-pane-anim)';
  node.style.left = `${from.left}px`;
  node.style.top = `${from.top}px`;
  node.style.width = `${from.width}px`;
  node.style.height = `${from.height}px`;
  node.getBoundingClientRect();
  node.style.transition = ZOOM_FLIP_TRANSITION;
  Object.assign(node.style, to);
  let done = false;
  let timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    unlisten();
    clearTimeout(timer);
    node.style.transition = '';
    node.style.zIndex = '';
  };
  const unlisten = onMorphEnd(node, finish);
  timer = window.setTimeout(finish, MORPH_FALLBACK_MS);
}

// A pane that disappears this soon after entering is a transient (e.g. the
// intermediate split of a CLI float-create) — drop it instantly instead of
// running a leave morph for a pane the user never meant to see.
const TRANSIENT_PANE_MS = 300;

export function PaneLayout({ children }: PaneLayoutProps) {
  const send = useAppSend();

  const visiblePanes = useAppSelector(selectVisiblePanes);
  const hiddenWindowPanes = useAppSelector(selectHiddenWindowPanes);
  const draggedPaneId = useAppSelector(selectDraggedPaneId);
  const dropTarget = useAppSelector(selectDropTarget);
  const {
    charWidth,
    charHeight,
    totalWidth: serverTotalWidth,
    totalHeight: serverTotalHeight,
  } = useAppSelector(selectGridDimensions);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  // While a sidebar column slides, the container's width changes every frame
  // but the GRID does not: it was re-tiled for the settled width the moment
  // the toggle started (`beginSidebarMotion`). Centring a settled grid inside
  // a moving container is what used to walk the pane area sideways for the
  // length of the animation — opening the RIGHT column moved the panes' LEFT
  // edge, which nothing about that gesture should touch. Measuring against
  // the width the grid was sized for holds it still, and it is already the
  // width the offset would settle at.
  //
  // The GRID's width is taken from the target too, for the same reason: tmux's
  // re-tile lands somewhere in the middle of the animation, and an offset
  // computed from the old column count steps when it arrives. Both halves of
  // the sum settled means the offset is its final value from the first frame,
  // so the pane area simply does not move.
  const sidebarMotion = useAppSelector((ctx) => ctx.sidebarMotion);
  const settledPaneWidth = useAppSelector(selectSettledPaneWidth);
  const targetCols = useAppSelector((ctx) => ctx.targetCols);
  const settledMotion = sidebarMotion && settledPaneWidth !== null && settledPaneWidth > 0;
  const centeringWidth = settledMotion ? settledPaneWidth : containerWidth;
  const dragOffsetX = useAppSelector(selectDragOffsetX);
  const dragOffsetY = useAppSelector(selectDragOffsetY);
  const enableAnimations = useAppSelector(selectEnableAnimations);
  const suppressLayoutTransition = useAppSelector(selectSuppressLayoutTransition);
  const groupSwitchPanes = useAppSelector(selectGroupSwitchPaneIds);
  const paneKeyOverrides = useAppSelector(selectPaneKeyOverrides);

  // The active cue means "the keyboard is in this tiled pane".
  const keyboardElsewhere = useAppSelector(selectKeyboardElsewhere);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  // tmux shows ONLY the zoomed pane — the others are not visible at all. The
  // layout still knows their geometry, so without this they keep painting
  // underneath and show through the zoomed pane's translucent surface.
  const isZoomed = useAppSelector((ctx) =>
    Boolean(ctx.windows.find((w) => w.id === ctx.activeWindowId)?.zoomed),
  );
  const allPanes = useAppSelector((ctx) => ctx.panes);
  // A trackpad gesture, as far as the panes are concerned. Each of these
  // changes once per gesture, never per step - GestureStage draws the steps.
  const swipeNeighbor = useAppSelector(selectSwipeNeighbor);
  const swipeStill = useAppSelector(selectSwipeStill);
  const gesturePaneId = useAppSelector(selectGesturePaneId);
  const isDragging = useIsDragging();
  const isResizing = useIsResizing();

  const dragOffset = useMemo(
    () => ({ x: dragOffsetX, y: dragOffsetY }),
    [dragOffsetX, dragOffsetY],
  );

  // The grid is the visible panes' extent (see gridExtent): panes of other
  // windows sit in independent layouts, and centering on them would put the
  // active window's grid off-center.
  const { totalWidth, totalHeight } = useMemo(() => {
    const { cols, rows } = gridExtent(visiblePanes, null, {
      cols: serverTotalWidth,
      rows: serverTotalHeight,
    });
    return { totalWidth: cols, totalHeight: rows };
  }, [visiblePanes, serverTotalWidth, serverTotalHeight]);

  // Which pane tmux has expanded to fill the window, or null when not zoomed.
  //
  // Identified by geometry rather than by `pane.active`: when a window is
  // zoomed tmux reports exactly one pane spanning the whole grid, and that is
  // true regardless of which client holds focus. Keying off `active` would drop
  // the zoom treatment (or, worse, hide every pane) whenever the active flag has
  // not propagated yet. See `findZoomedPane` for why it must be the pane that
  // covers BOTH corners of the grid.
  const zoomedPaneId = useMemo(
    () => (isZoomed ? (findZoomedPane(visiblePanes)?.tmuxId ?? null) : null),
    [isZoomed, visiblePanes],
  );

  // Half a charWidth — each pane reaches this far into the tmux separator
  // column on both sides so adjacent panes' outlines coincide pixel-for-pixel
  // at the shared edge (the "mosaic" look). Also the content's horizontal
  // padding, which centers the terminal text within the +1-cell-wide box.
  const hPadding = charWidth / 2;

  // Center the pane grid in the container.
  // .pane-layout is inset by CONTAINER_PADDING_X/BOTTOM (CSS), so its dimensions match
  // containerWidth/Height (content-box from ResizeObserver). No padding-box
  // arithmetic needed — pane positions are relative to the content area directly.
  const liveCenteringOffset = useMemo(() => {
    const paneContentWidth = (settledMotion ? targetCols : totalWidth) * charWidth;
    const paneContentHeight = totalHeight * charHeight;
    // Clamp x so content never overflows the right edge.
    // This handles transient states where tmux totalWidth > targetCols.
    const idealX = (centeringWidth - paneContentWidth) / 2;
    const maxX = centeringWidth - paneContentWidth;
    return {
      x: Math.max(0, Math.min(idealX, maxX)),
      // Round to integer pixels so pane tops sit on whole-pixel rows —
      // matches the Math.round applied to `left` in getPaneStyle and
      // avoids sub-pixel anti-aliasing across cell-row boundaries.
      y: Math.round(Math.max(0, (containerHeight - paneContentHeight) / 2)),
    };
  }, [
    totalWidth,
    totalHeight,
    charWidth,
    charHeight,
    centeringWidth,
    containerHeight,
    settledMotion,
    targetCols,
  ]);

  // Freeze the centering offset for the duration of a drag OR resize. Mid-drag
  // the dragged pane is pinned to its original slot while the optimistic swap
  // patch moves the hovered pane into that same slot; mid-resize the preview /
  // intermediate server layouts can transiently change the derived grid extent
  // (e.g. a pane clamped at its min size). In both cases re-centering would
  // shift EVERY pane by a cell under the user's cursor — the "row jumps up and
  // then back down while resizing" glitch. Freeze so uninvolved panes hold
  // still and only the resized panes move.
  const frozenOffsetRef = useRef(liveCenteringOffset);
  if (!isDragging && !isResizing) {
    frozenOffsetRef.current = liveCenteringOffset;
  }
  const centeringOffset = isDragging || isResizing ? frozenOffsetRef.current : liveCenteringOffset;

  // The point all non-zoomed panes collapse toward (and expand out of) during
  // a zoom: the centre of the pane grid, where the zoomed pane fills to.
  const zoomCenter = useMemo(
    () => ({
      x: centeringOffset.x + (totalWidth * charWidth) / 2,
      y: centeringOffset.y + (totalHeight * charHeight) / 2,
    }),
    [centeringOffset, totalWidth, totalHeight, charWidth, charHeight],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Pane enter/leave/shift lifecycle state (split & kill morph animations).
  // See the detection block below `renderedPanes` for the mechanics.
  const [, bumpAnimTick] = useReducer((x: number) => x + 1, 0);
  const enterAnimsRef = useRef(new Map<string, EnterAnim>());
  const shiftAnimsRef = useRef(new Map<string, ShiftAnim>());
  // The zoomed pane id across commits, for the zoom-out sibling expand. The
  // zooming pane's own grow/shrink is driven by the DOM instead (see the zoom
  // MutationObserver below).
  const prevZoomedRef = useRef<string | null>(null);
  // On zoom-OUT the collapsed siblings drop their `pane-zoom-collapsing` class in
  // the same commit that suppresses layout transitions, so without a carve-out
  // they snap from centre-scaled back to their slots. This holds the sibling
  // keys for the expand duration so a `pane-zoom-expanding` class (with a gated
  // transition) animates them back out of the centre.
  const zoomExpandRef = useRef<{ keys: Set<string>; timer?: number } | null>(null);
  const leavingRef = useRef(new Map<string, LeaveAnim>());
  const prevViewRef = useRef<Map<string, RenderedPaneView> | null>(null);
  const prevActiveWindowIdRef = useRef<string | null | undefined>(undefined);
  const prevAllPaneIdsRef = useRef<Set<string>>(new Set());

  // Handle global mouse/touch events during drag/resize
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        send({ type: 'DRAG_MOVE', clientX: e.clientX, clientY: e.clientY });
      } else if (isResizing) {
        send({ type: 'RESIZE_MOVE', clientX: e.clientX, clientY: e.clientY });
      }
    };

    const handleMouseUp = () => {
      if (isDragging) {
        send({ type: 'DRAG_END' });
      } else if (isResizing) {
        send({ type: 'RESIZE_END' });
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      const t = e.touches[0];
      send({ type: 'DRAG_MOVE', clientX: t.clientX, clientY: t.clientY });
    };

    const handleTouchEnd = () => {
      if (isDragging) {
        send({ type: 'DRAG_END' });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', handleTouchEnd);
    window.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
      window.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isDragging, isResizing, send]);

  const getPaneStyle = useCallback(
    (pane: TmuxPane): React.CSSProperties => {
      // Uniform mosaic box: width = charWidth*(width+1), height =
      // charHeight*(height+1). The extra cell in each axis is the border whose
      // two halves are shared with neighbours (or the grid edge). See
      // computePaneBox for the geometry. A collapsed stacked pane (height 1)
      // therefore renders as 2 rows — its header title row plus a blank content
      // row — matching tmux; TerminalPane hides the content of that row.
      const box = computePaneBox(pane, charWidth, charHeight, centeringOffset.x, centeringOffset.y);
      return {
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // Content padding: half a cell each side so the terminal text fills its
        // exact charWidth*width and aligns to the tmux column grid.
        '--pane-h-padding-left': `${hPadding}px`,
        '--pane-h-padding-right': `${hPadding}px`,
      } as React.CSSProperties;
    },
    [charWidth, charHeight, centeringOffset, hPadding],
  );

  const getPaneClassName = useCallback(
    (pane: TmuxPane, key: string): string => {
      const classes = ['pane-layout-item'];
      const isActive = pane.active && !keyboardElsewhere;
      classes.push(isActive ? 'pane-active' : 'pane-inactive');
      // tmux's marked pane: a distinct outline so it reads apart from the
      // active pane (the two are usually different panes — mark one, then
      // swap/join it from another).
      if (pane.marked) classes.push('pane-marked');
      if (pane.tmuxId === zoomedPaneId) {
        classes.push('pane-zoomed');
      }
      if (zoomExpandRef.current?.keys.has(key)) {
        classes.push('pane-zoom-expanding');
      }
      if (pane.tmuxId === draggedPaneId) {
        classes.push('pane-dragging');
      } else if (enterAnimsRef.current.has(key)) {
        classes.push('pane-entering');
      } else if (shiftAnimsRef.current.has(key)) {
        classes.push('pane-shifting');
      }
      if (swipeStill) classes.push('pane-swipe-still');
      return classes.join(' ');
    },
    [draggedPaneId, keyboardElsewhere, zoomedPaneId, swipeStill],
  );

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

  // ============================================
  // Pane enter/leave/shift lifecycle (split & kill morph animations)
  // ============================================
  //
  // Each render is diffed against a snapshot of the previous render
  // (prevViewRef, updated post-commit in a layout effect). A key that
  // appears gets a FLIP enter (mounted at final geometry, rewound to the
  // split source's pre-split box before paint, transitioned into place
  // while fading in); a key that vanishes holds the shift clock open for the
  // duration, shrinking into its own centre under the survivor while fading out; panes
  // whose box changed alongside an enter/leave get `pane-shifting` so they
  // animate on the same clock. All state is local (refs + a tick reducer)
  // — detection mutations in the render phase are add-only and keyed, so
  // StrictMode's double render is a no-op; deletions happen in effects.

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

  // The grid's pixel extent, for the zoom MutationObserver to tell a pane
  // filling the grid from one in its slot. The full-extent (zoomed) pane's
  // cell height is one row short of the grid (the pane-border-status header
  // row), so a cell-dimension test misses it - but its *pixel* box spans the
  // whole grid (computePaneBox adds the header row back), which is the
  // reliable signal.
  const zoomGeometryRef = useRef({ gridWidth: 0, gridHeight: 0, charWidth, charHeight });
  zoomGeometryRef.current = {
    gridWidth: totalWidth * charWidth,
    gridHeight: totalHeight * charHeight,
    charWidth,
    charHeight,
  };
  // The zoomed pane as of this render and the one before it changed, for the
  // observer to tell a zoom from a pane closing or splitting whether the
  // zoomed flag lands with the geometry or a render after it.
  const zoomRenderRef = useRef<{ now: string | null; before: string | null }>({
    now: null,
    before: null,
  });
  if (zoomRenderRef.current.now !== zoomedPaneId) {
    zoomRenderRef.current = { now: zoomedPaneId, before: zoomRenderRef.current.now };
  }

  const prevView = prevViewRef.current;
  const lifecycleEnabled =
    prevView !== null &&
    enableAnimations &&
    !isDragging &&
    !isResizing &&
    activeWindowId === prevActiveWindowIdRef.current;

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

  // A closed pane leaves no node behind: the model dropped it, so it is gone
  // from the render on the same commit. What is still tracked is the WINDOW
  // its removal opened — `leavingRef` keeps the shift lifecycle running for
  // PANE_LEAVE_MS so the surviving panes grow into the space on that clock
  // rather than snapping to their new boxes.
  const renderItems: {
    key: string;
    pane: TmuxPane;
    hidden: boolean;
    zoomCollapsed: boolean;
    swipeSide: number;
  }[] = renderedPanes.map(({ pane, hidden, zoomCollapsed, swipeSide }) => ({
    key: paneKeyOverrides[pane.tmuxId] ?? pane.tmuxId,
    pane,
    hidden,
    zoomCollapsed,
    swipeSide,
  }));

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
  }, []);

  // Zoom FLIP, driven by the DOM. A zoom reaches the panes as a box change -
  // one pane to the full grid, or back to its slot - and the window's zoomed
  // flag can land a render later, so diffing renders either misses the moment
  // or catches it after the full box has already been painted. The observer
  // sees the exact style mutation, before paint, with the box the pane really
  // had, and animates from there - or from where a committed pinch left the
  // pane (zoomHandoff), so the zoom carries straight on from the fingers.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const watch = (node: Node) => {
      if (isPaneItem(node)) {
        observer.observe(node, {
          attributes: true,
          attributeFilter: ['style'],
          attributeOldValue: true,
        });
      }
    };
    const isPaneItem = (node: Node) =>
      node instanceof HTMLElement && node.classList.contains('pane-layout-item');
    const observer = new MutationObserver((records) => {
      let removed = false;
      const before = new Map<HTMLElement, string>();
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach(watch);
          r.removedNodes.forEach((n) => {
            if (isPaneItem(n)) removed = true;
          });
        } else if (r.oldValue !== null && !before.has(r.target as HTMLElement)) {
          before.set(r.target as HTMLElement, r.oldValue);
        }
      }
      const { gridWidth, gridHeight, charWidth: cw, charHeight: ch } = zoomGeometryRef.current;
      const full = (b: PaneBox) => b.width >= gridWidth - cw && b.height >= gridHeight - ch;
      const zoom = zoomRenderRef.current;
      for (const [node, oldStyle] of before) {
        const from = styleBox(oldStyle);
        const to = styleBox(node.getAttribute('style') ?? '');
        if (!from || !to || full(from) === full(to)) continue;
        const id = node.dataset.paneId ?? '';
        // Filling the grid is a zoom when this pane is the zoomed one, or when
        // its siblings are all still here (tmux keeps them while zoomed and
        // the flag can lag) - not when one of them just closed. Leaving it is
        // an unzoom only for the pane that was zoomed, not a split.
        const zooming = full(to)
          ? zoom.now === id || !removed
          : zoom.now === id || zoom.before === id;
        if (!zooming) continue;
        const handoff = takeZoomHandoff(id);
        if (handoff) {
          // The pinch stops drawing the pane - and the grid - this same frame.
          node.style.transform = '';
          container.style.transform = '';
          send({ type: 'GESTURE_SETTLE' });
        }
        flipZoom(node, handoff ?? from);
      }
      // The FLIP's own writes are not zooms.
      observer.takeRecords();
    });
    observer.observe(container, { childList: true });
    container.childNodes.forEach(watch);
    return () => observer.disconnect();
  }, [send]);

  return (
    <div
      ref={containerRef}
      className={`pane-layout ${isDragging ? 'pane-layout-dragging' : ''} ${isResizing || suppressLayoutTransition ? 'pane-layout-resizing' : ''} ${!enableAnimations ? 'pane-layout-no-animations' : ''}`}
    >
      {renderItems.map(({ key, pane, hidden, zoomCollapsed, swipeSide }) => {
        if (zoomCollapsed) {
          // A zoomed sibling: keep it at its real box but transform it toward
          // the grid centre, scaled down and faded out, so zoom IN reads as
          // the panes collapsing into the middle while the zoomed pane grows
          // — and zoom OUT reverses it (the DOM node persists by key, so the
          // base transform/opacity transition runs both ways). computePaneBox
          // via getPaneStyle; translate the pane's centre onto zoomCenter.
          const box = getPaneStyle(pane);
          const cx = (box.left as number) + (box.width as number) / 2;
          const cy = (box.top as number) + (box.height as number) / 2;
          return (
            <AnimatedPaneWrapper
              key={key}
              paneKey={key}
              pane={pane}
              className="pane-layout-item pane-inactive pane-zoom-collapsing"
              style={box}
              targetX={0}
              targetY={0}
              elevated={false}
              collapseTransform={`translate(${zoomCenter.x - cx}px, ${zoomCenter.y - cy}px) scale(var(--zoom-collapse-scale, 0.4))`}
            >
              {children(pane)}
            </AnimatedPaneWrapper>
          );
        }

        if (swipeSide !== 0) {
          // The tab a slide is pulling in: its real panes at their own boxes,
          // one grid width to the side, moving with the grid's transform.
          return (
            <AnimatedPaneWrapper
              key={key}
              paneKey={key}
              pane={pane}
              className="pane-layout-item pane-inactive pane-swipe-neighbor"
              style={getPaneStyle(pane)}
              targetX={swipeSide * swipeOffsetPx(totalWidth, charWidth)}
              targetY={0}
              elevated={false}
            >
              {children(pane)}
            </AnimatedPaneWrapper>
          );
        }

        if (hidden) {
          // Window-hidden (another tab's pane): mounted but display:none — no
          // positioning math, no animation, no event handlers. Preserves
          // <TerminalPane> + content so a tab switch shows it instantly.
          return (
            <AnimatedPaneWrapper
              key={key}
              paneKey={key}
              pane={pane}
              className="pane-layout-item pane-window-hidden"
              style={{ display: 'none' }}
              targetX={0}
              targetY={0}
              elevated={false}
            >
              {children(pane)}
            </AnimatedPaneWrapper>
          );
        }

        const isDraggedPane = pane.tmuxId === draggedPaneId;
        const baseStyle = getPaneStyle(pane);

        const isGroupSwitchPane = groupSwitchPanes?.has(pane.tmuxId) ?? false;
        const style = isGroupSwitchPane ? { ...baseStyle, transition: 'none' } : baseStyle;

        const shouldFollowCursor = isDraggedPane && isDragging;

        // A pinch draws this pane where the fingers have it: no transform of
        // React's own, so GestureStage's inline one stands.
        const pinched = pane.tmuxId === gesturePaneId;

        return (
          <AnimatedPaneWrapper
            key={key}
            paneKey={key}
            pane={pane}
            className={`${getPaneClassName(pane, key)}${pinched ? ' pane-gesture-growing' : ''}`}
            style={style}
            targetX={shouldFollowCursor ? dragOffset.x : 0}
            targetY={shouldFollowCursor ? dragOffset.y : 0}
            elevated={shouldFollowCursor}
            collapseTransform={pinched ? '' : undefined}
          >
            {children(pane)}
          </AnimatedPaneWrapper>
        );
      })}

      {/* Ghost indicator showing dragged pane's current grid position.
          Mirrors getPaneStyle exactly (same computePaneBox) so the ghost
          lands precisely where the pane will. */}
      {dropTarget &&
        isDragging &&
        (() => {
          const box = computePaneBox(
            dropTarget,
            charWidth,
            charHeight,
            centeringOffset.x,
            centeringOffset.y,
          );
          return <div className="pane-drag-ghost" style={{ position: 'absolute', ...box }} />;
        })()}

      <ResizeDividers
        panes={visiblePanes}
        charWidth={charWidth}
        charHeight={charHeight}
        centeringOffset={centeringOffset}
      />
    </div>
  );
}

// ============================================
// Animated Pane Wrapper
// ============================================

interface AnimatedPaneWrapperProps {
  pane: TmuxPane;
  /** Effective React key (paneKeyOverrides honored) — exposed on the DOM
   * for the enter-animation FLIP to find the node post-commit. */
  paneKey: string;
  className: string;
  style: React.CSSProperties;
  targetX: number;
  targetY: number;
  elevated: boolean;
  /** When set, overrides the translate3d transform — the zoom-collapse
   *  translate-to-centre + scale (see the zoom-collapse render branch), or a
   *  empty while a pinch draws the pane (GestureStage owns its transform). */
  collapseTransform?: string;
  children: ReactNode;
}

function AnimatedPaneWrapper({
  pane,
  paneKey,
  className,
  style,
  targetX,
  targetY,
  elevated,
  collapseTransform,
  children,
}: AnimatedPaneWrapperProps) {
  const transformStyle: React.CSSProperties = {
    ...style,
    transform: collapseTransform ?? `translate3d(${targetX}px, ${targetY}px, 0)`,
    zIndex: elevated ? 'var(--z-dragging)' : undefined,
  };

  return (
    <div
      data-pane-id={pane.tmuxId}
      data-pane-key={paneKey}
      className={className}
      style={transformStyle}
    >
      {children}
    </div>
  );
}

export default PaneLayout;
