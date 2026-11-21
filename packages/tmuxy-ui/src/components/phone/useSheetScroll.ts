/**
 * Scrolling on the compose sheet (ComposeSheet.tsx): the text box scrolls only
 * when what is written is taller than it, and nothing else on the sheet
 * scrolls at all. On a phone, a slide on a text box whose text fits, or on the
 * sheet around it, still moves something: the page bounces, and with the
 * keyboard up the sheet and the keyboard slide under the finger. So a slide
 * anywhere on the sheet is stopped, unless it lands on the text box while it
 * has more to show or while a selection in it is being dragged.
 *
 * And as a phone's own sheets do, a finger that goes down on the text box
 * while its text is at the top pulls the sheet down with it, to close it
 * (`SheetPull`, useSheetDrag.ts); one that rested first is selecting text.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { SheetPull } from './useSheetDrag';

/** How far a finger moves before its slide has a direction. */
const SLOP_PX = 8;
/** A finger resting this long before it moves is a press: a selection, not a pull. */
const PRESS_MS = 400;

const overflows = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;
const selecting = (el: HTMLTextAreaElement) => el.selectionStart !== el.selectionEnd;

export interface Touching {
  id: number;
  x0: number;
  y0: number;
  at0: number;
  mode: 'undecided' | 'pull' | 'other';
}

/**
 * What a finger's first slide on the text box is: still too short to tell, a
 * pull of the sheet (down, more than sideways, quickly, with the text at its
 * top and nothing being selected), or anything else.
 */
export function slideMode(
  from: { x: number; y: number; at: number },
  to: { x: number; y: number; at: number },
  textAtTop: boolean,
): Touching['mode'] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return 'undecided';
  const pulls = dy > Math.abs(dx) && to.at - from.at < PRESS_MS && textAtTop;
  return pulls ? 'pull' : 'other';
}

/** The sheet's touch listeners on `root`: stop stray slides, pull from the text box. */
function followTouches(
  root: HTMLElement,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  pullRef: RefObject<SheetPull | null>,
): () => void {
  let touch: Touching | null = null;
  const own = (e: TouchEvent) =>
    touch ? [...e.changedTouches].find((t) => t.identifier === touch!.id) : undefined;

  const start = (e: TouchEvent) => {
    const el = inputRef.current;
    const t = e.changedTouches[0];
    touch =
      el && t && e.touches.length === 1 && el.contains(e.target as Node)
        ? { id: t.identifier, x0: t.clientX, y0: t.clientY, at0: e.timeStamp, mode: 'undecided' }
        : null;
  };
  // The touch's point in this event, while it is (or has just become) a pull.
  const pulling = (e: TouchEvent, el: HTMLTextAreaElement | null) => {
    const t = own(e);
    if (!touch || !t) return undefined;
    if (el && touch.mode === 'undecided') {
      const from = { x: touch.x0, y: touch.y0, at: touch.at0 };
      const to = { x: t.clientX, y: t.clientY, at: e.timeStamp };
      touch.mode = slideMode(from, to, el.scrollTop <= 0 && !selecting(el));
      if (touch.mode === 'pull') pullRef.current?.begin(touch.id, touch.y0, touch.at0);
    }
    return touch.mode === 'pull' ? t : undefined;
  };
  // A slide the text box takes: it has more to show, or a selection is dragged.
  const scrollsTheBox = (e: TouchEvent, el: HTMLTextAreaElement | null) =>
    el !== null && el.contains(e.target as Node) && (overflows(el) || selecting(el));
  const move = (e: TouchEvent) => {
    const el = inputRef.current;
    const t = pulling(e, el);
    if (t) pullRef.current?.move(t.identifier, t.clientY, e.timeStamp);
    else if (scrollsTheBox(e, el)) return;
    if (e.cancelable) e.preventDefault();
  };
  const end = (e: TouchEvent) => {
    const t = own(e);
    if (touch?.mode === 'pull') pullRef.current?.release(touch.id, t?.clientY ?? touch.y0);
    touch = null;
  };
  const cancel = () => {
    if (touch?.mode === 'pull') pullRef.current?.cancel();
    touch = null;
  };

  root.addEventListener('touchstart', start, { passive: true });
  root.addEventListener('touchmove', move, { passive: false });
  root.addEventListener('touchend', end);
  root.addEventListener('touchcancel', cancel);
  return () => {
    root.removeEventListener('touchstart', start);
    root.removeEventListener('touchmove', move);
    root.removeEventListener('touchend', end);
    root.removeEventListener('touchcancel', cancel);
  };
}

export function useSheetScroll(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  text: string,
  pull: SheetPull,
) {
  const [overflowing, setOverflowing] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  // The latest pull, for listeners that live as long as the sheet: a gesture
  // must outlive the renders its own moves cause.
  const pullRef = useRef<SheetPull | null>(null);
  useLayoutEffect(() => {
    pullRef.current = pull;
  });

  // Whether the text box has more than it shows: after each change of text,
  // and whenever its box changes size (the keyboard coming up or going).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el) setOverflowing(overflows(el));
  }, [inputRef, text]);
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setOverflowing(overflows(el)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [inputRef]);

  useEffect(() => {
    const root = backdropRef.current;
    if (!root) return;
    return followTouches(root, inputRef, pullRef);
  }, [inputRef]);

  return { backdropRef, overflowing };
}
