/**
 * ⌨ held on the key row (KeyRow.tsx): the compose sheet. The sheet opens as
 * the hold is reached (`HOLD_MS`, a hold anywhere on the phone); the release
 * gives its text box the focus, a touch's end being when a phone puts its
 * keyboard up for a focus at all. `wasHeld` tells the click that ends a hold
 * it was one, not a tap that toggles the keyboard.
 */

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { HOLD_MS } from './touchGesture';

export function useComposeHold() {
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; held: boolean }>({
    timer: null,
    held: false,
  });

  useEffect(() => {
    const pending = hold.current;
    return () => {
      if (pending.timer !== null) clearTimeout(pending.timer);
    };
  }, []);

  const down = (e: PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    hold.current.held = false;
    hold.current.timer = setTimeout(() => {
      hold.current.timer = null;
      hold.current.held = true;
      setComposing(true);
    }, HOLD_MS);
  };
  const up = () => {
    if (hold.current.timer !== null) clearTimeout(hold.current.timer);
    hold.current.timer = null;
    if (hold.current.held) inputRef.current?.focus();
  };
  const wasHeld = () => {
    if (!hold.current.held) return false;
    hold.current.held = false;
    return true;
  };

  return { composing, inputRef, down, up, wasHeld, close: () => setComposing(false) };
}
