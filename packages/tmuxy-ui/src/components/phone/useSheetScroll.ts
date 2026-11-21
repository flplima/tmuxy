/**
 * Scrolling on the compose sheet (ComposeSheet.tsx): the text box scrolls only
 * when what is written is taller than it, and nothing else on the sheet
 * scrolls at all. On a phone, a slide on a text box whose text fits, or on the
 * sheet around it, still moves something: the page bounces, and with the
 * keyboard up the sheet and the keyboard slide under the finger. So a slide
 * anywhere on the sheet is stopped, unless it lands on the text box while it
 * has more to show or while a selection in it is being dragged.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const overflows = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;

export function useSheetScroll(inputRef: RefObject<HTMLTextAreaElement | null>, text: string) {
  const [overflowing, setOverflowing] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

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
    const hold = (e: TouchEvent) => {
      const el = inputRef.current;
      if (el && el.contains(e.target as Node)) {
        if (overflows(el) || el.selectionStart !== el.selectionEnd) return;
      }
      if (e.cancelable) e.preventDefault();
    };
    root.addEventListener('touchmove', hold, { passive: false });
    return () => root.removeEventListener('touchmove', hold);
  }, [inputRef]);

  return { backdropRef, overflowing };
}
