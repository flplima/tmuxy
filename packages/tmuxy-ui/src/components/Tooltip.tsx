/**
 * In place of the browser's `title`, which waits about a second, cannot be
 * styled and never appears for a keyboard user.
 *
 * It clones its single child rather than wrapping it: a wrapper would break
 * every `>` selector the stylesheets aim at these buttons. The trigger's box
 * comes from the event, so a child that already holds a ref keeps it.
 *
 * The label repeats the trigger's `aria-label`, so it is hidden from
 * assistive technology rather than announced twice.
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
import { surfacePortalTarget } from './floating/useFloatingSurface';
import './Tooltip.css';

export const TOOLTIP_DELAY_MS = 400;

const GAP_PX = 6;

interface TriggerProps {
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

interface TooltipProps {
  /** Nothing renders when it is empty. */
  label: ReactNode;
  /** Preferred side. Flips when the viewport has no room for it. */
  placement?: 'top' | 'bottom';
  children: ReactElement<TriggerProps>;
}

function chain<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) {
  return (e: E) => {
    theirs?.(e);
    ours(e);
  };
}

export function Tooltip({ label, placement = 'bottom', children }: TooltipProps) {
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

  // Anything that moves the trigger closes it: chasing the trigger would cost
  // a layout read on every frame of a scroll.
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
      timerRef.current = window.setTimeout(() => openFrom(el), TOOLTIP_DELAY_MS);
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
          surfacePortalTarget(),
        )}
    </>
  );
}
