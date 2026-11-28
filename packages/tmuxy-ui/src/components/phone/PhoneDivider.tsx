/**
 * PhoneDivider — the handle along the top of the phone's bottom sheet, upright
 * (the rules are domain/phoneSplit.ts). Dragged down it zooms the terminal,
 * the panes, their headers and tmux's status line growing together as one
 * picture from the top-left corner, as far as the sheet has room to give.
 * Dragged up it raises the sheet over the page, which keeps its size and
 * fades to dark under it; let go, the sheet settles covering the page or back
 * under the keys, and dragged down again it goes back.
 *
 * While the finger has it the handle writes the zoom and the lift straight
 * onto the page (`--phone-zoom`, and `--phone-sheet-lift` and
 * `--phone-sheet-cover` that styles/phone.css raises the sheet and fades the
 * page by), so the drag moves with the finger without a render per step; on
 * release the split goes to the machine, which keeps it per device and draws
 * the same thing, the stylesheet animating the sheet the rest of the way.
 */

import { memo, useEffect, useRef, type PointerEvent, type RefObject } from 'react';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import {
  dragSplit,
  releaseSplit,
  type PhoneSplit,
  type SplitDrag,
  type SplitPosition,
} from '../../domain/phoneSplit';

interface Drag extends SplitDrag {
  pointerId: number;
  /** Where the finger was when the drag began. */
  y0: number;
  now: SplitPosition;
  lastY: number;
  lastAt: number;
  /** Downward speed at the last move, px/ms. */
  speed: number;
}

const LIFT = '--phone-sheet-lift';
const COVER = '--phone-sheet-cover';
/** The page's height, which a covering sheet rises by. */
const PAGE_HEIGHT = '--phone-top-height';

/** Draw a position while the finger has the handle. */
function paint(pty: HTMLElement, body: HTMLElement | null, pos: SplitPosition, cover: number) {
  pty.style.setProperty('--phone-zoom', String(pos.zoom));
  pty.classList.toggle('is-zoomed', pos.zoom > 1);
  body?.style.setProperty(LIFT, `${pos.lift}px`);
  body?.style.setProperty(COVER, String(cover > 0 ? Math.min(1, pos.lift / cover) : 0));
}

/** Hand the page back to the state's classes, which animate from where the finger left it. */
function settle(pty: HTMLElement, body: HTMLElement | null, split: PhoneSplit) {
  pty.style.setProperty('--phone-zoom', String(split.zoom));
  pty.classList.toggle('is-zoomed', split.zoom > 1);
  if (!body) return;
  body.style.removeProperty(LIFT);
  body.style.removeProperty(COVER);
  body.classList.toggle('is-collapsed', split.collapsed);
  delete body.dataset.sheetDragging;
}

/** The terminal's height at its own size, the most it can grow to, and the page's height. */
function measure(
  top: HTMLElement | null,
  pty: HTMLElement | null,
  lower: HTMLElement | null,
  handle: HTMLElement,
): Pick<SplitDrag, 'base' | 'room' | 'cover'> | null {
  const picture = pty?.querySelector<HTMLElement>('.phone-picture');
  if (!pty || !picture) return null;
  return {
    base: picture.offsetHeight,
    room: pty.clientHeight + Math.max(0, (lower?.clientHeight ?? 0) - handle.offsetHeight),
    cover: top?.offsetHeight ?? 0,
  };
}

/** A covering sheet rises by the page's height, which a keyboard changes: kept on the app body. */
function usePageHeight(topRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const top = topRef.current;
    const body = top?.closest<HTMLElement>('.app-body');
    if (!top || !body) return;
    const observer = new ResizeObserver(() =>
      body.style.setProperty(PAGE_HEIGHT, `${top.offsetHeight}px`),
    );
    observer.observe(top);
    return () => {
      observer.disconnect();
      body.style.removeProperty(PAGE_HEIGHT);
    };
  }, [topRef]);
}

export const PhoneDivider = memo(function PhoneDivider({
  topRef,
  ptyRef,
  lowerRef,
}: {
  topRef: RefObject<HTMLDivElement | null>;
  ptyRef: RefObject<HTMLDivElement | null>;
  lowerRef: RefObject<HTMLDivElement | null>;
}) {
  const send = useAppSend();
  const zoom = useAppSelector((ctx) => ctx.phoneZoom);
  const collapsed = useAppSelector((ctx) => ctx.phoneCollapsed);
  const dragRef = useRef<Drag | null>(null);

  usePageHeight(topRef);

  const body = () => ptyRef.current?.closest<HTMLElement>('.app-body') ?? null;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = measure(topRef.current, ptyRef.current, lowerRef.current, e.currentTarget);
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = { zoom, collapsed };
    dragRef.current = {
      ...box,
      start,
      now: { zoom, lift: collapsed ? box.cover : 0 },
      pointerId: e.pointerId,
      y0: e.clientY,
      lastY: e.clientY,
      lastAt: e.timeStamp,
      speed: 0,
    };
    e.currentTarget.dataset.dragging = 'true';
    const b = body();
    if (b) b.dataset.sheetDragging = 'true';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const pty = ptyRef.current;
    if (!drag || !pty || e.pointerId !== drag.pointerId) return;
    if (e.timeStamp > drag.lastAt)
      drag.speed = (e.clientY - drag.lastY) / (e.timeStamp - drag.lastAt);
    drag.lastY = e.clientY;
    drag.lastAt = e.timeStamp;
    drag.now = dragSplit(drag, e.clientY - drag.y0);
    paint(pty, body(), drag.now, drag.cover);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const pty = ptyRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    delete e.currentTarget.dataset.dragging;
    const split = releaseSplit(drag, drag.now, drag.speed);
    if (pty) settle(pty, body(), split);
    send({ type: 'SET_PHONE_SPLIT', zoom: split.zoom, collapsed: split.collapsed });
  };

  return (
    <div
      className="phone-divider"
      data-testid="phone-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Drag down to zoom the terminal, or up to raise this sheet over it"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <i className="phone-divider-handle" />
    </div>
  );
});
