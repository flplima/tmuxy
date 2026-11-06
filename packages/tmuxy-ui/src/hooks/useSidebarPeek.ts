/**
 * Sidebar peek — rest the mouse on a closed sidebar's header toggle and the
 * column comes out over the panes; move off the toggle and the column, and it
 * goes. A click on the toggle docks it as before. This is how a collapsed
 * sidebar behaves in the Claude desktop app, with the things its users report
 * going wrong there designed out:
 *
 *  - The flyout closing while the pointer travels from the button to the
 *    panel. The toggle and the column are one hover area, and leaving it
 *    only starts a short grace period that coming back cancels.
 *  - A menu opened from the panel closing under the pointer. The tree's
 *    context menus render in a portal, outside the column's box: the pointer
 *    on a menu counts as on the column, and an open menu, or a field in the
 *    column with the focus (a rename), keeps the peek.
 *
 * Where the pointer is, not which element last heard an enter or a leave,
 * decides it: while a column peeks, every mouse move over the page is checked
 * against the hover area. Enter and leave events are not enough, because an
 * element removed from under the pointer (a menu closed by Escape) never
 * reports a leave, and the peek would stay out until the next pass over it.
 *
 * Mouse only. A touch or a pen has no hover to rest, and a tap on the toggle
 * is the click that docks the column.
 *
 * The timers are the module's, not a component's: the toggle (in the header)
 * opens a peek and the column (in the body) holds it. One column peeks at a
 * time.
 */

import { useCallback, useEffect, type PointerEvent } from 'react';
import { useAppSend } from '../machines/appHooks';

/** A rest this long on a toggle brings its column out; a pointer crossing the header opens nothing. */
export const PEEK_OPEN_DELAY_MS = 150;
/** Off the toggle and the column this long, the peek goes: long enough to cross between them. */
export const PEEK_CLOSE_DELAY_MS = 300;

let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

function clearOpen() {
  if (openTimer !== null) clearTimeout(openTimer);
  openTimer = null;
}

function clearClose() {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
}

/** The peek's hover area: its column, its toggle, and any menu open over them. */
function inPeekArea(target: EventTarget | null, side: 'left' | 'right'): boolean {
  return (
    target instanceof Element &&
    target.closest(`.sidebar-column.is-peek, .sidebar-toggle-${side}, [role="menu"]`) !== null
  );
}

/** Something the user is in the middle of keeps the peek: a menu, or a field with the focus. */
function peekIsBusy(): boolean {
  if (document.querySelector('[role="menu"]')) return true;
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.matches('input, textarea, [contenteditable="true"]') &&
    active.closest('.sidebar-column.is-peek') !== null
  );
}

/**
 * The toggle's half: a rest on it opens the peek, a pass over it does not.
 * `enabled` is false while the column is docked: the toggle is then only the
 * button that shuts it.
 */
export function useSidebarPeekToggle(side: 'left' | 'right', enabled: boolean) {
  const send = useAppSend();

  const onPointerEnter = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType !== 'mouse' || !enabled) return;
      clearOpen();
      openTimer = setTimeout(() => {
        openTimer = null;
        send({ type: 'PEEK_SIDEBAR', side });
      }, PEEK_OPEN_DELAY_MS);
    },
    [enabled, send, side],
  );

  const onPointerLeave = useCallback(() => clearOpen(), []);

  return { onPointerEnter, onPointerLeave };
}

/**
 * The column's half, while it peeks: follow the mouse over the whole page and
 * end the peek once it has been out of the hover area for the grace period,
 * or has left the window.
 */
export function useSidebarPeekHold(side: 'left' | 'right', peeking: boolean) {
  const send = useAppSend();

  useEffect(() => {
    if (!peeking) return;
    const close = () => {
      if (peekIsBusy()) {
        closeTimer = setTimeout(close, PEEK_CLOSE_DELAY_MS);
        return;
      }
      closeTimer = null;
      send({ type: 'END_SIDEBAR_PEEK' });
    };
    const scheduleClose = () => {
      if (closeTimer === null) closeTimer = setTimeout(close, PEEK_CLOSE_DELAY_MS);
    };
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (inPeekArea(e.target, side)) clearClose();
      else scheduleClose();
    };
    // Off the page altogether: no move will say so.
    const onOut = (e: MouseEvent) => {
      if (e.relatedTarget === null) scheduleClose();
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('mouseout', onOut, true);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mouseout', onOut, true);
      clearClose();
    };
  }, [peeking, send, side]);
}
