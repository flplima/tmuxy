/**
 * PhoneDivider — the bar between the phone's terminal (with its keys) and the
 * bottom view, upright. Dragged down it zooms the terminal, the panes, their
 * headers and tmux's status line growing together as one picture from the
 * top-left corner, as far as the bottom view has room to give; dragged up
 * from the terminal's own size it folds the terminal and the keys away and
 * the bottom view takes the whole height, and dragged down again it brings
 * them back. The rules are utils/phoneSplit.ts.
 *
 * While the finger has it the bar writes the zoom and the fold straight onto
 * the page (the `--phone-zoom` the stylesheet scales by, and the classes the
 * state draws), so the drag moves with the finger without a render per
 * step; on release the split goes to the machine, which keeps it per device
 * and draws the same thing.
 */

import { memo, useRef, type PointerEvent, type RefObject } from 'react';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { dragSplit, releaseSplit, type PhoneSplit, type SplitDrag } from '../utils/phoneSplit';

interface Drag extends SplitDrag {
  pointerId: number;
  /** Where the finger was when the drag (or its last fold) began. */
  y0: number;
  now: PhoneSplit;
}

/** Draw a split on the page, as the state would. */
function paint(pty: HTMLElement, split: PhoneSplit) {
  pty.style.setProperty('--phone-zoom', String(split.zoom));
  pty.classList.toggle('is-zoomed', split.zoom > 1);
  pty.closest('.app-body')?.classList.toggle('is-collapsed', split.collapsed);
}

export const PhoneDivider = memo(function PhoneDivider({
  ptyRef,
  lowerRef,
}: {
  ptyRef: RefObject<HTMLDivElement | null>;
  lowerRef: RefObject<HTMLDivElement | null>;
}) {
  const send = useAppSend();
  const zoom = useAppSelector((ctx) => ctx.phoneZoom);
  const collapsed = useAppSelector((ctx) => ctx.phoneCollapsed);
  const dragRef = useRef<Drag | null>(null);

  /** The terminal's height at its own size, and the most it can grow to. */
  const measure = (): { base: number; room: number } | null => {
    const pty = ptyRef.current;
    const picture = pty?.querySelector<HTMLElement>('.phone-picture');
    if (!pty || !picture) return null;
    return {
      base: picture.offsetHeight,
      room: pty.clientHeight + (lowerRef.current?.clientHeight ?? 0),
    };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = measure();
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { zoom, collapsed };
    dragRef.current = { ...box, start, now: start, pointerId: e.pointerId, y0: e.clientY };
    e.currentTarget.dataset.dragging = 'true';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const pty = ptyRef.current;
    if (!drag || !pty || e.pointerId !== drag.pointerId) return;
    const next = dragSplit(drag, e.clientY - drag.y0);
    paint(pty, next);
    drag.now = next;
    // Folded or unfolded: the drag goes on from here, measured anew.
    if (next.collapsed !== drag.start.collapsed) {
      const box = measure();
      dragRef.current = { ...drag, ...(box ?? {}), start: next, y0: e.clientY };
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const pty = ptyRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    delete e.currentTarget.dataset.dragging;
    const split = releaseSplit(drag.now, drag.base);
    if (pty) paint(pty, split);
    send({ type: 'SET_PHONE_SPLIT', zoom: split.zoom, collapsed: split.collapsed });
  };

  return (
    <div
      className="phone-divider"
      data-testid="phone-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag to zoom the terminal, or up to fold it away"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <i className="phone-divider-handle" />
    </div>
  );
});
