/**
 * Tooltip — the app's own, in place of the browser's `title`.
 *
 * A native tooltip waits about a second, ignores the theme, cannot be styled
 * and never appears for a keyboard user. This one follows the theme's
 * surfaces and the app's own transition speed, opens on hover or focus, and
 * closes on leave, blur, press, Escape or scroll.
 *
 * It clones its single child rather than wrapping it: a wrapper element would
 * sit in the DOM between a parent and its child and quietly break every
 * `>` selector the stylesheets aim at these buttons. Nothing but event
 * handlers is added, and the trigger's own box comes from the event, so a
 * child that already holds a ref keeps it.
 *
 * The label repeats what the trigger's `aria-label` already says, so it is
 * hidden from assistive technology rather than announced twice.
 */

import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

/** How long the pointer has to rest before the tooltip opens. */
export const TOOLTIP_DELAY_MS = 400;

/** Distance between the trigger's edge and the tooltip. */
const GAP_PX = 6;

/**
 * Where the tooltip is rendered: out of the trigger's subtree, so no pane's
 * `overflow: hidden` clips it and no transformed ancestor becomes its
 * containing block — but still inside the app's own element, so the
 * `@tmuxy-animations off` gate on it reaches the tooltip too. The chrome is
 * not there in a story that mounts one component on its own; the body will
 * do, and positioning is identical either way (a fixed box is placed against
 * the viewport, and neither element transforms).
 */
function portalTarget(): HTMLElement {
  return document.querySelector<HTMLElement>('.app-container') ?? document.body;
}

interface TriggerProps {
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

interface TooltipProps {
  /** What the tooltip says. Nothing renders when it is empty. */
  label: ReactNode;
  /** Preferred side. Flips when the viewport has no room for it. */
  placement?: 'top' | 'bottom';
  /** Milliseconds of hover before it opens. Focus opens it at once. */
  delay?: number;
  children: ReactElement<TriggerProps>;
}

/** Run the child's own handler, then ours. */
function chain<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) {
  return (e: E) => {
    theirs?.(e);
    ours(e);
  };
}

export function Tooltip({ label, placement = 'bottom', delay, children }: TooltipProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setAnchor(null);
    setAt(null);
  }, []);

  const openFrom = useCallback((el: HTMLElement) => {
    setAt(null);
    setAnchor(el.getBoundingClientRect());
  }, []);

  // Placed once per opening, from the tooltip's real size: it flips to the
  // other side of the trigger when the viewport has no room, and is kept
  // clear of both edges.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const { width, height } = tip.getBoundingClientRect();
    const below = anchor.bottom + GAP_PX;
    const above = anchor.top - height - GAP_PX;
    const fitsBelow = below + height <= window.innerHeight - GAP_PX;
    const fitsAbove = above >= GAP_PX;
    const top = placement === 'top' ? (fitsAbove ? above : below) : fitsBelow ? below : above;
    const centred = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(Math.max(centred, GAP_PX), window.innerWidth - width - GAP_PX);
    setAt({ left, top: Math.max(GAP_PX, top) });
  }, [anchor, placement]);

  // Anything that moves the trigger out from under the tooltip closes it:
  // its position was measured once, and chasing the trigger would cost a
  // layout read on every frame of a scroll.
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, close]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const trigger = cloneElement(children, {
    // A touch is a tap, not a hover: opening there would put the tooltip
    // over whatever the finger was aiming at.
    onPointerEnter: chain(children.props.onPointerEnter, (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.currentTarget;
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => openFrom(el), delay ?? TOOLTIP_DELAY_MS);
    }),
    onPointerLeave: chain(children.props.onPointerLeave, close),
    onPointerDown: chain(children.props.onPointerDown, close),
    onFocus: chain(children.props.onFocus, (e) => openFrom(e.currentTarget)),
    onBlur: chain(children.props.onBlur, close),
  });

  return (
    <>
      {trigger}
      {label !== '' &&
        label != null &&
        anchor &&
        createPortal(
          <div
            ref={tipRef}
            className="tooltip"
            role="tooltip"
            aria-hidden="true"
            data-testid="tooltip"
            style={{
              left: at?.left ?? 0,
              top: at?.top ?? 0,
              // Measured before it is placed; showing it at 0,0 for that
              // frame would flash it in the corner.
              visibility: at ? 'visible' : 'hidden',
            }}
          >
            {label}
          </div>,
          portalTarget(),
        )}
    </>
  );
}
