/**
 * The toggle and the column are one hover area, and leaving it only starts a
 * grace period that coming back cancels. The tree's context menus render in a
 * portal, outside the column's box, so the pointer on a menu counts as on the
 * column, and an open menu or a focused field in the column keeps the peek.
 *
 * Every mouse move over the page is checked against the hover area, because
 * an element removed from under the pointer (a menu closed by Escape) never
 * reports a leave.
 *
 * Mouse only: a touch or a pen has no hover to rest. The timers are the
 * module's, since the toggle (in the header) opens a peek and the column (in
 * the body) holds it.
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

function inPeekArea(target: EventTarget | null, side: 'left' | 'right'): boolean {
  return (
    target instanceof Element &&
    target.closest(`.sidebar-column.is-peek, .sidebar-toggle-${side}, [role="menu"]`) !== null
  );
}

function peekIsBusy(): boolean {
  if (document.querySelector('[role="menu"]')) return true;
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active.matches('input, textarea, [contenteditable="true"]') &&
    active.closest('.sidebar-column.is-peek') !== null
  );
}

/** `enabled` is false while the column is docked. */
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
