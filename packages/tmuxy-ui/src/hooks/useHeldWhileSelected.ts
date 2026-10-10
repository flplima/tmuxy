/**
 * useHeldWhileSelected — keep the live screen still while the browser has a
 * selection on it.
 *
 * The live grid's rows are reused by screen index: when the program prints
 * and the screen scrolls, row 3 stays row 3 and gets the text that was on
 * row 4. The browser's selection is a range over those row nodes, so it stays
 * on the same rows while the text under it moves — what the user dragged over
 * is no longer what is highlighted, and Cmd+C copies the wrong lines.
 *
 * A terminal freezes the view while text is selected (tmux's copy mode, every
 * emulator's selection). This is that: from the first selection change that
 * leaves a non-collapsed range inside the pane until it collapses, the grid
 * and cursor handed to the renderer are the ones on screen when the selection
 * began. The program keeps running; the pane catches up the moment the
 * selection is gone.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PaneContent } from '../domain/wire';

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
  // The latest live screen, for the listener to capture at the moment the
  // selection appears, without re-subscribing on every frame.
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
