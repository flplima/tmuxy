import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import './SmoothCursor.css';
import { getCursorAnchor, getCursorAnchorVersion, subscribeCursorAnchor } from './cursorAnchor';
import { isSceneChange, parseScene, sceneKey, type Scene } from './cursorScene';
import { useAppSelector } from '../../machines/appHooks';

/**
 * The cursor as one overlay for the whole app that glides between positions,
 * Neovide-style: the corners facing the direction of travel arrive fast, the
 * ones behind lag, so a jump smears and snaps back into a cell — within a
 * pane, to another pane, into the dock or a float.
 *
 * Switching tabs or the shown member of a pane group does NOT glide: the whole
 * picture under the cursor is replaced, so a glide would show motion that did
 * not happen.
 */

const LEAD_TAU_MS = 11;
const TRAIL_TAU_MS = 32;
const SETTLE_PX = 0.75;
/** Re-measuring after a commit, to follow CSS transitions underneath. */
const FOLLOW_MS = 450;
/**
 * Longer than FOLLOW_MS: the new pane's capture can refill its screen a beat
 * after the switch, moving the cursor from a provisional spot to its prompt,
 * and that second move belongs to the switch.
 */
const SCENE_SNAP_MS = 1500;
const FLY_FROM_MEMORY_MS = 800;
const PAGE_FOLLOW_MS = 150;
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
  blink: boolean;
  char: string;
  font: string;
  letterSpacing: string;
}

function targetOf(anchor: HTMLElement): Target | null {
  // A pane still entering is on its way from the pane it split from to its
  // own box: its cursor rides that slide, and following it smeared a bar
  // across the other pane's text. Drawn once the pane is in place, flying in
  // from where the cursor was, as any jump to another pane does.
  if (anchor.closest('.pane-entering')) return null;
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
    blink: cls.contains('terminal-cursor-blink'),
    char: anchor.textContent ?? ' ',
    font: cs.font,
    letterSpacing: cs.letterSpacing,
  };
}

/**
 * Every clipping ancestor's box, intersected. The nearest is not enough: a
 * pane's terminal is sized to its row count and anchored to the pane's bottom,
 * so while the pane opens it hangs off the pane's top, and a first-row cursor
 * is inside the terminal but clipped by the pane.
 */
function clipRectOf(el: HTMLElement): DOMRect | null {
  let left = -Infinity;
  let top = -Infinity;
  let right = Infinity;
  let bottom = Infinity;
  let found = false;
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflow === 'visible') continue;
    const box = node.getBoundingClientRect();
    // A wrapper with no box of its own (`display: contents`, an unlaid-out
    // node) clips nothing; intersecting its empty rect would hide everything.
    if (box.width === 0 || box.height === 0) continue;
    left = Math.max(left, box.left);
    top = Math.max(top, box.top);
    right = Math.min(right, box.right);
    bottom = Math.min(bottom, box.bottom);
    found = true;
  }
  if (!found) return null;
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
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
  snapUntil: number;
  scene: Scene | null;
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
  // The anchor also moves without the pane's cursor re-rendering: the Tab
  // Overview zooming, a sidebar opening, a font or viewport change.
  const layoutKey = useAppSelector(
    (ctx) =>
      `${ctx.tabOverviewOpen}|${ctx.sidebars.left.open}|${ctx.sidebars.right.open}|${ctx.containerWidth}x${ctx.containerHeight}|${ctx.charWidth}|${ctx.baseFontSize}|${ctx.activeWindowId}`,
  );
  const scene = useAppSelector((ctx) =>
    sceneKey({
      window: ctx.windows.some((w) => w.id === ctx.activeWindowId && w.windowType === 'tab')
        ? ctx.activeWindowId
        : null,
      pane: ctx.activePaneId,
      group:
        Object.values(ctx.paneGroups).find(
          (g) => ctx.activePaneId !== null && g.paneIds.includes(ctx.activePaneId),
        )?.id ?? null,
    }),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const blinkRef = useRef<HTMLDivElement>(null);
  const shapeRef = useRef<HTMLDivElement>(null);
  const charRef = useRef<HTMLSpanElement>(null);
  const motion = useRef<Motion>({
    snapUntil: 0,
    scene: null,
    corners: null,
    leading: [true, true, true, true],
    target: null,
    raf: 0,
    lastFrame: 0,
    followUntil: 0,
    lostAt: 0,
  });

  const wake = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const m = motion.current;
    return () => cancelAnimationFrame(m.raf);
  }, []);

  // The embedding page scrolling or resizing moves the anchor under this fixed
  // overlay without a render. Follow in place: a glide would trail the text.
  useLayoutEffect(() => {
    const onPageMove = () => {
      const m = motion.current;
      const until = performance.now() + PAGE_FOLLOW_MS;
      m.snapUntil = Math.max(m.snapUntil, until);
      m.followUntil = Math.max(m.followUntil, until);
      wake.current?.();
    };
    window.addEventListener('scroll', onPageMove, { capture: true, passive: true });
    window.addEventListener('resize', onPageMove, { passive: true });
    return () => {
      window.removeEventListener('scroll', onPageMove, { capture: true });
      window.removeEventListener('resize', onPageMove);
    };
  }, []);

  useLayoutEffect(() => {
    const m = motion.current;
    m.followUntil = performance.now() + FOLLOW_MS;
    // The anchor of the new tab or member can attach a frame before or after
    // the state that names it, and its content can settle later still.
    const next = parseScene(scene);
    if (isSceneChange(m.scene, next)) m.snapUntil = performance.now() + SCENE_SNAP_MS;
    m.scene = next;
    wake.current = () => {
      if (m.raf || typeof requestAnimationFrame !== 'function') return;
      m.lastFrame = performance.now();
      m.raf = requestAnimationFrame(frame);
    };
    wake.current();

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
        // A pane opening carries its cursor in from off its own edge, and no
        // render announces the frames in between.
        if (now < m.followUntil) m.raf = requestAnimationFrame(frame);
        return;
      }

      if (!m.target || !sameBox(m.target, target)) {
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
        // A cursor being typed at stays solid: restart the blink. Rewinding the
        // running animation avoids the reflow a class flip costs per keystroke.
        blinkRef.current?.getAnimations?.().forEach((a) => {
          a.currentTime = 0;
        });
      }
      m.target = target;

      const dest = cornersOf(target);
      const hidden = root.style.opacity !== '1';
      const snap =
        reducedMotion() || now < m.snapUntil || (hidden && now - m.lostAt > FLY_FROM_MEMORY_MS);
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
      root.classList.toggle('is-blinking', target.blink);
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
  }, [version, layoutKey, scene]);

  return (
    <div ref={rootRef} className="smooth-cursor" aria-hidden="true" data-testid="smooth-cursor">
      {/* The blink lives on its own layer: the root's and the glyph's opacity
          are written every frame by the glide, so an animation on either would
          be overwritten. */}
      <div ref={blinkRef} className="smooth-cursor-blink">
        <div ref={shapeRef} className="smooth-cursor-shape" />
        <span ref={charRef} className="smooth-cursor-char" />
      </div>
    </div>
  );
}
