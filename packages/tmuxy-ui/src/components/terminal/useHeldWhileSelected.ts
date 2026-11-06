/**
 * Keep the live screen still while the browser has a selection on it, as a
 * terminal emulator freezes its view while text is selected.
 *
 * The live grid reuses row nodes by screen index, and the browser's selection
 * is a range over those nodes: output that scrolled the screen slid other text
 * under the highlight, and Cmd+C copied the wrong lines.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PaneContent } from '../../domain/wireCells';

export interface LiveScreen {
  content: PaneContent;
  cursorX: number;
  cursorY: number;
}

export function useHeldWhileSelected(
  live: LiveScreen,
  container: RefObject<HTMLElement | null>,
  enabled: boolean,
): LiveScreen {
  const [held, setHeld] = useState<LiveScreen | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!enabled) {
      setHeld(null);
      return;
    }
    const onSelectionChange = () => {
      const selection = window.getSelection();
      const node = selection?.anchorNode ?? null;
      const inside =
        !!selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        !!node &&
        !!container.current?.contains(node);
      setHeld((current) => {
        if (inside) return current ?? liveRef.current;
        return current ? null : current;
      });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [container, enabled]);

  return held ?? live;
}
