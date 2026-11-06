/**
 * A mousedown inside an `<iframe>` belongs to the frame's document and never
 * reaches the pane wrapper. Focus is the one signal that crosses the
 * boundary: clicking into a frame blurs the parent window and makes the
 * `<iframe>` the parent document's `activeElement`. Reading it there activates
 * the pane without taking the click away from the page, as a terminal pane
 * focuses and forwards the same click.
 */

import { useEffect, type RefObject } from 'react';
import { useAppSend } from '../machines/appHooks';
import type { PaneId } from '../domain/ids';

/** Only frames inside `ref` count, so one pane's hook cannot activate its neighbour. */
export function useFramedPaneFocus(paneId: PaneId, ref: RefObject<HTMLElement | null>): void {
  const send = useAppSend();

  useEffect(() => {
    const onBlur = () => {
      // The window also blurs when the user switches app or tab, and the
      // frame they last clicked is still `activeElement` — but then the
      // document does not have focus, which is what tells the two apart.
      if (!document.hasFocus()) return;
      const active = document.activeElement;
      if (!active || active.tagName !== 'IFRAME') return;
      if (!ref.current?.contains(active)) return;
      send({ type: 'FOCUS_PANE', paneId });
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [paneId, ref, send]);
}
