/**
 * useFramedPaneFocus — activate a pane when the user clicks the page inside it.
 *
 * A widget that embeds an `<iframe>` (the `browser` widget) is a hole in the
 * app's event surface: everything that happens inside the frame belongs to
 * that document, so no mousedown ever reaches the pane wrapper and the pane it
 * is in never becomes the active one. Clicking a browser pane left the
 * keyboard, the pane highlight and every pane-scoped command pointed at
 * whatever pane was active before.
 *
 * Focus is the one signal that does cross the boundary: clicking into a frame
 * blurs the parent window and makes that `<iframe>` element the parent
 * document's `activeElement`. Reading it there activates the pane WITHOUT
 * taking the click away from the page — one click both focuses the pane and
 * presses the button under the cursor, which is how a tiled terminal pane
 * already behaves (`usePaneMouse` focuses unconditionally and forwards the
 * same event).
 *
 * The alternative — covering an inactive frame with a shield that swallows the
 * first click — would make every browser pane a click-to-focus-then-click
 * affair and would take wheel scrolling away from an unfocused pane, both of
 * which terminal panes do not do.
 */

import { useEffect, type RefObject } from 'react';
import { useAppSend } from '../machines/AppContext';

/**
 * @param paneId - the pane to activate
 * @param ref - the pane's root element; only frames inside it count, so one
 *   pane's hook cannot activate its neighbour
 */
export function useFramedPaneFocus(paneId: string, ref: RefObject<HTMLElement | null>): void {
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
      // A no-op when the pane is already active.
      send({ type: 'FOCUS_PANE', paneId });
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [paneId, ref, send]);
}
