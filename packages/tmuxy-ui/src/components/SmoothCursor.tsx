import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import './SmoothCursor.css';
import { getCursorAnchor, getCursorAnchorVersion, subscribeCursorAnchor } from './cursorAnchor';
import { useAppSelector } from '../machines/AppContext';

/**
 * The cursor as a single overlay that glides between positions, Neovide-style.
 *
 * Each of the cursor box's four corners eases toward its destination on its
 * own clock: the corners facing the direction of travel arrive fast, the ones
 * behind lag, so a jump stretches the block into a smear that snaps back into
 * a cell. Because the overlay is one element for the whole app — anchored to
 * whichever pane holds the keyboard (see cursorAnchor.ts) — the same glide
 * covers a move within a pane, a jump to another pane, and a jump into the
 * dock or a float.
 *
 * The overlay measures the anchor on every commit that touched it and then on
 * every frame while anything is still moving, so it also follows the anchor
 * through CSS transitions the app runs underneath it (a pane re-tiling, a
 * sidebar sliding) without being told.
 */

/** Time constants of the corner easing: the leading corners and the trailing ones. */
const LEAD_TAU_MS = 11;
const TRAIL_TAU_MS = 32;
/** Below this many pixels off target a corner is snapped onto it. */
const SETTLE_PX = 0.75;
/** How long after a commit the overlay keeps re-measuring, to follow transitions. */
const FOLLOW_MS = 450;
/** A cursor that reappears within this long flies in from where the last one was. */
const FLY_FROM_MEMORY_MS = 800;
/** The block's glyph is painted once every corner is this close. */
const GLYPH_AT_PX = 1.5;

type Pt = { x: number; y: number };
type Mode = 'block' | 'bar' | 'underline';

interface Target {
  left: number;
  top: number;
  width: number;
  height: number;
  mode: Mode;
  copy: boolean;
  char: string;
  font: string;
  letterSpacing: string;
}

/** The shape to draw for the anchor: its cell, thinned to a bar or an underline. */
function targetOf(anchor: HTMLElement): Target | null {
  const r = anchor.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const clip = clipRectOf(anchor);
  if (
    clip &&
    (r.left < clip.left - 1 ||
      r.right > clip.right + 1 ||
      r.top < clip.top - 1 ||
      r.bottom > clip.bottom + 1)
  ) {
    return null;
  }
  const cls = anchor.classList;
  const mode: Mode = cls.contains('terminal-cursor-bar')
    ? 'bar'
    : cls.contains('terminal-cursor-underline')
      ? 'underline'
      : 'block';
  const cs = getComputedStyle(anchor);
  return {
    left: r.left,
    top: mode === 'underline' ? r.bottom - 2 : r.top,
    width: mode === 'bar' ? 2 : r.width,
    height: mode === 'underline' ? 2 : r.height,
    mode,
    copy: cls.contains('terminal-cursor-copy'),
    char: anchor.textContent ?? ' ',
    font: cs.font,
    letterSpacing: cs.letterSpacing,
  };
}

/** The box of the nearest ancestor that clips: a cursor scrolled out of it is not shown. */
function clipRectOf(el: HTMLElement): DOMRect | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflow;
    if (overflow !== 'visible') return node.getBoundingClientRect();
  }
  return null;
}

function cornersOf(t: Target): Pt[] {
  return [
    { x: t.left, y: t.top },
    { x: t.left + t.width, y: t.top },
    { x: t.left + t.width, y: t.top + t.height },
    { x: t.left, y: t.top + t.height },
  ];
}

const sameBox = (a: Target, b: Target) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Motion {
  corners: Pt[] | null;
  leading: boolean[];
  target: Target | null;
  raf: number;
  lastFrame: number;
  followUntil: number;
  lostAt: number;
}

export function SmoothCursor() {
  const version = useSyncExternalStore(
    subscribeCursorAnchor,
    getCursorAnchorVersion,
    getCursorAnchorVersion,
  );
  // The anchor also moves when the DOM around it does without the pane's
  // cursor re-rendering: the pane grid zooming into the Tab Overview, a
  // sidebar sliding, a font or viewport change. A single key over those
  // states wakes the overlay to follow.
  const layoutKey = useAppSelector(
    (ctx) =>
      `${ctx.tabOverviewOpen}|${ctx.sidebarMotion}|${ctx.leftSidebarOpen}|${ctx.rightSidebarOpen}|${ctx.containerWidth}x${ctx.containerHeight}|${ctx.charWidth}|${ctx.baseFontSize}|${ctx.activeWindowId}`,
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);
  const charRef = useRef<HTMLSpanElement>(null);
  const motion = useRef<Motion>({
    corners: null,
    leading: [true, true, true, true],
    target: null,
    raf: 0,
    lastFrame: 0,
    followUntil: 0,
    lostAt: 0,
  });

  useLayoutEffect(() => {
    const m = motion.current;
    return () => cancelAnimationFrame(m.raf);
  }, []);

  // The anchor was (re)attached or detached: measure now and keep following
  // for a while, since the DOM it sits in may still be transitioning.
  useLayoutEffect(() => {
    const m = motion.current;
    m.followUntil = performance.now() + FOLLOW_MS;
    if (m.raf || typeof requestAnimationFrame !== 'function') return;
    m.lastFrame = performance.now();
    m.raf = requestAnimationFrame(frame);

    function frame(now: number) {
      m.raf = 0;
      const root = rootRef.current;
      const shape = shapeRef.current;
      const glyph = charRef.current;
      if (!root || !shape || !glyph) return;

      const dt = Math.min(50, Math.max(0, now - m.lastFrame));
      m.lastFrame = now;

      const anchor = getCursorAnchor();
      const target = anchor && anchor.isConnected ? targetOf(anchor) : null;
      if (!target) {
        if (m.target) m.lostAt = now;
        m.target = null;
        root.style.opacity = '0';
        return;
      }

      if (!m.target || !sameBox(m.target, target)) {
        // A new destination: the corners on the side we are heading to lead.
        const from = m.target ?? target;
        const dx = target.left + target.width / 2 - (from.left + from.width / 2);
        const dy = target.top + target.height / 2 - (from.top + from.height / 2);
        const offsets = [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ];
        m.leading = offsets.map((o) => o.x * dx + o.y * dy >= 0);
        glyph.style.font = target.font;
        glyph.style.letterSpacing = target.letterSpacing;
      }
      m.target = target;

      const dest = cornersOf(target);
      // Appear in place unless a cursor was showing a moment ago, in which
      // case glide in from where it was (the pane-to-pane jump).
      const hidden = root.style.opacity !== '1';
      const snap = reducedMotion() || (hidden && now - m.lostAt > FLY_FROM_MEMORY_MS);
      if (snap || !m.corners) m.corners = dest.map((p) => ({ ...p }));

      let maxDist = 0;
      m.corners.forEach((c, i) => {
        const tau = m.leading[i] ? LEAD_TAU_MS : TRAIL_TAU_MS;
        const k = 1 - Math.exp(-dt / tau);
        c.x += (dest[i].x - c.x) * k;
        c.y += (dest[i].y - c.y) * k;
        const d = Math.hypot(dest[i].x - c.x, dest[i].y - c.y);
        if (d < SETTLE_PX) {
          c.x = dest[i].x;
          c.y = dest[i].y;
        } else if (d > maxDist) {
          maxDist = d;
        }
      });

      shape.style.clipPath = `polygon(${m.corners.map((c) => `${c.x}px ${c.y}px`).join(', ')})`;
      root.classList.toggle('is-copy', target.copy);
      root.style.opacity = '1';

      const showGlyph = target.mode === 'block' && maxDist < GLYPH_AT_PX;
      glyph.style.opacity = showGlyph ? '1' : '0';
      if (showGlyph) {
        glyph.style.transform = `translate(${target.left}px, ${target.top}px)`;
        glyph.style.width = `${target.width}px`;
        glyph.style.height = `${target.height}px`;
        glyph.style.lineHeight = `${target.height}px`;
        if (glyph.textContent !== target.char) glyph.textContent = target.char;
      }

      if (maxDist > 0 || now < m.followUntil) m.raf = requestAnimationFrame(frame);
    }
  }, [version, layoutKey]);

  return (
    <div ref={rootRef} className="smooth-cursor" aria-hidden="true" data-testid="smooth-cursor">
      <div ref={shapeRef} className="smooth-cursor-shape" />
      <span ref={charRef} className="smooth-cursor-char" />
    </div>
  );
}
