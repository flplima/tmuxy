/**
 * TabOverview — the Safari-style "all tabs" view (ctrl+0, prefix w).
 *
 * Opening it zooms the current tab's pane grid OUT into a slot in a grid of
 * every tab; picking a slot zooms that tab back IN and makes it current.
 *
 *  - Each slot is a card: a header row with the tab's strip number and name
 *    and a ✕ that closes the tab, then a frame drawing the tab's pane layout
 *    to scale, each pane box showing the pane's screen as it was when the
 *    overview opened (the machine's `tabOverviewSnapshot`: a still, so a tab
 *    that keeps printing does not churn its thumbnail). The current tab's
 *    frame is the FLIP target: the live `.pane-layout` is scaled into it
 *    (see the CSS custom properties set on `.pane-container`).
 *  - The trailing slot is a dashed "+" that creates a tab.
 *  - Keyboard while open: arrows / hjkl move, Enter opens, Delete / x closes
 *    the selected tab, 1–9 open the Nth tab, Escape or ctrl+0 leaves. The
 *    overview owns the keyboard: nothing reaches tmux.
 *  - Drag a slot to reorder (a mouse drags after a few pixels, a finger after
 *    a long press); the drop goes to tmux as a `move-window`.
 *
 * State (open flag, keyboard cursor) lives in the app machine; the drag is
 * transient pointer state and stays here.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectVisibleWindows,
  selectPanes,
  selectContainerSize,
  selectCharSize,
} from '../machines/AppContext';
import { dropIndex, overviewSlots, stillPanes } from '../utils/tabOverview';
import { LogProfiler } from '../utils/renderLog';
import { Terminal } from './Terminal';

/** Pixels a mouse must travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 6;
/** How long a finger holds before a touch press becomes a drag. */
const LONG_PRESS_MS = 300;

interface DragState {
  windowId: string;
  fromIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  /** Current pointer offset from the press, for the dragged card's transform. */
  dx: number;
  dy: number;
  /** Where the card would land, as an index among the OTHER tabs. */
  overIndex: number;
  /** True once the threshold / long-press turned the press into a drag. */
  active: boolean;
}

export const TabOverview = memo(function TabOverview() {
  const open = useAppSelector((ctx) => ctx.tabOverviewOpen);
  if (!open) return null;
  return (
    <LogProfiler id="TabOverview">
      <TabOverviewInner />
    </LogProfiler>
  );
});

function TabOverviewInner() {
  const send = useAppSend();
  const selected = useAppSelector((ctx) => ctx.tabOverviewSelected);
  const activeWindowId = useAppSelector((ctx) => ctx.activeWindowId);
  const windows = useAppSelectorShallow(selectVisibleWindows);
  const livePanes = useAppSelectorShallow(selectPanes);
  const snapshot = useAppSelector((ctx) => ctx.tabOverviewSnapshot);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const slots = useMemo(
    () => overviewSlots(windows, stillPanes(livePanes, snapshot)),
    [windows, livePanes, snapshot],
  );
  // A frame's pixel box, so each pane's still can be scaled from its cell
  // size into its share of the frame. Every frame has the same size (one grid
  // track, one aspect ratio), so one measurement serves them all.
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const longPressRef = useRef<number | null>(null);

  // ---- FLIP: scale the live pane grid into the current tab's frame ----------
  // Measured after layout so the grid's real slot geometry is known. The
  // numbers go on `.pane-container` as custom properties; the CSS applies them
  // to `.pane-layout` while the container carries `tab-overview-open`.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const container = root?.parentElement;
    const layout = container?.querySelector<HTMLElement>('.pane-layout');
    const frame = root?.querySelector<HTMLElement>(
      '.tab-overview-slot.is-active .tab-overview-frame',
    );
    const anyFrame = root?.querySelector<HTMLElement>('.tab-overview-frame');
    if (anyFrame) {
      const r = anyFrame.getBoundingClientRect();
      if (r.width > 0 && (r.width !== frameSize?.width || r.height !== frameSize?.height)) {
        setFrameSize({ width: r.width, height: r.height });
      }
    }
    if (!container || !layout || !frame) return;
    const from = layout.getBoundingClientRect();
    const to = frame.getBoundingClientRect();
    if (from.width === 0 || from.height === 0) return;
    // The layout may already be mid-transform from a previous measurement;
    // offsetLeft/Top give its untransformed origin in the container.
    const originX = layout.offsetLeft;
    const originY = layout.offsetTop;
    const containerBox = container.getBoundingClientRect();
    const targetX = to.left - containerBox.left;
    const targetY = to.top - containerBox.top;
    const sx = to.width / layout.offsetWidth;
    const sy = to.height / layout.offsetHeight;
    container.style.setProperty('--tab-overview-x', `${targetX - originX}px`);
    container.style.setProperty('--tab-overview-y', `${targetY - originY}px`);
    container.style.setProperty('--tab-overview-sx', String(sx));
    container.style.setProperty('--tab-overview-sy', String(sy));
  }, [slots.length, containerWidth, containerHeight, activeWindowId, frameSize]);

  // ---- keyboard: the overview owns every key while it is open ---------------
  const stateRef = useRef({ slots, selected, send });
  stateRef.current = { slots, selected, send };
  useEffect(() => {
    const columns = () => {
      const cards = gridRef.current?.querySelectorAll<HTMLElement>('.tab-overview-slot');
      if (!cards || cards.length === 0) return 1;
      const top = cards[0].offsetTop;
      let n = 0;
      for (const c of cards) {
        if (c.offsetTop !== top) break;
        n++;
      }
      return Math.max(1, n);
    };
    const handler = (e: KeyboardEvent) => {
      const { slots: s, selected: sel, send: dispatch } = stateRef.current;
      const swallow = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.ctrlKey && e.key === '0') {
        swallow();
        dispatch({ type: 'CLOSE_TAB_OVERVIEW' });
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        // Chords mean nothing here and must not reach a pane behind the overview.
        swallow();
        return;
      }
      switch (e.key) {
        case 'Escape':
          swallow();
          dispatch({ type: 'CLOSE_TAB_OVERVIEW' });
          return;
        case 'ArrowLeft':
        case 'h':
          swallow();
          dispatch({ type: 'TAB_OVERVIEW_MOVE', delta: -1 });
          return;
        case 'ArrowRight':
        case 'l':
          swallow();
          dispatch({ type: 'TAB_OVERVIEW_MOVE', delta: 1 });
          return;
        case 'ArrowUp':
        case 'k':
          swallow();
          dispatch({ type: 'TAB_OVERVIEW_MOVE', delta: -columns() });
          return;
        case 'ArrowDown':
        case 'j':
          swallow();
          dispatch({ type: 'TAB_OVERVIEW_MOVE', delta: columns() });
          return;
        case 'Enter':
        case ' ':
          swallow();
          dispatch({ type: 'TAB_OVERVIEW_ACTIVATE' });
          return;
        case 'Delete':
        case 'Backspace':
        case 'x': {
          swallow();
          const slot = s[sel];
          if (slot) dispatch({ type: 'CLOSE_TAB', windowId: slot.window.id });
          return;
        }
        default: {
          swallow();
          if (/^[1-9]$/.test(e.key)) {
            const index = Number(e.key) - 1;
            if (s[index]) dispatch({ type: 'TAB_OVERVIEW_ACTIVATE', index });
          }
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // ---- pointer: click to open, drag to reorder ------------------------------
  const centersExcluding = useCallback((windowId: string) => {
    const cards = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>('.tab-overview-slot[data-window-id]') ?? [],
    ).filter((c) => c.dataset.windowId !== windowId);
    return cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }, []);

  const clearLongPress = () => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    const slot = slots[index];
    if (!slot || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const state: DragState = {
      windowId: slot.window.id,
      fromIndex: index,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      overIndex: index,
      active: false,
    };
    setDrag(state);
    if (e.pointerType === 'touch') {
      clearLongPress();
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = null;
        setDrag((d) => (d && d.windowId === state.windowId ? { ...d, active: true } : d));
      }, LONG_PRESS_MS);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    let active = drag.active;
    if (!active) {
      if (e.pointerType === 'touch') {
        // A finger that moves before the long press fires is scrolling.
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX * 2) {
          clearLongPress();
          setDrag(null);
        }
        return;
      }
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      active = true;
    }
    const overIndex = dropIndex(centersExcluding(drag.windowId), { x: e.clientX, y: e.clientY });
    setDrag({ ...drag, dx, dy, overIndex, active });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    clearLongPress();
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const d = drag;
    setDrag(null);
    if (d.active) {
      if (d.overIndex !== d.fromIndex) {
        send({ type: 'REORDER_TAB', windowId: d.windowId, toIndex: d.overIndex });
      }
      return;
    }
    // A press that never became a drag is a click: open that tab.
    send({ type: 'TAB_OVERVIEW_ACTIVATE', index });
  };

  const handlePointerCancel = () => {
    clearLongPress();
    setDrag(null);
  };

  const aspect =
    containerWidth > 0 && containerHeight > 0 ? containerWidth / containerHeight : 16 / 9;
  const dragging = drag?.active ? drag : null;
  // Index (among the other tabs) that the dragged card would be inserted
  // before; the card at that strip index shows the drop marker.
  const dropMarkerAt = dragging
    ? dragging.overIndex >= dragging.fromIndex
      ? dragging.overIndex + 1
      : dragging.overIndex
    : -1;

  return (
    <div
      ref={rootRef}
      className="tab-overview"
      role="dialog"
      aria-label="All tabs"
      data-testid="tab-overview"
      onClick={(e) => {
        // The backdrop (anything outside a card) dismisses.
        if (e.target === e.currentTarget || e.target === gridRef.current) {
          send({ type: 'CLOSE_TAB_OVERVIEW' });
        }
      }}
    >
      <div
        ref={gridRef}
        className="tab-overview-grid"
        role="listbox"
        aria-activedescendant={`tab-overview-slot-${selected}`}
        style={{ '--tab-overview-aspect': String(aspect) } as React.CSSProperties}
      >
        {slots.map((slot, index) => {
          const isActive = slot.window.id === activeWindowId;
          const isDragged = dragging?.windowId === slot.window.id;
          const cls = [
            'tab-overview-slot',
            isActive ? 'is-active' : '',
            index === selected ? 'is-selected' : '',
            isDragged ? 'is-dragging' : '',
            dropMarkerAt === index ? 'is-drop-before' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const style = isDragged
            ? ({
                transform: `translate(${dragging!.dx}px, ${dragging!.dy}px)`,
              } as React.CSSProperties)
            : undefined;
          return (
            <div
              key={slot.window.id}
              id={`tab-overview-slot-${index}`}
              className={cls}
              style={style}
              role="option"
              aria-selected={index === selected}
              data-window-id={slot.window.id}
              data-testid={`tab-overview-slot-${slot.window.id}`}
              onPointerDown={(e) => handlePointerDown(e, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={(e) => handlePointerUp(e, index)}
              onPointerCancel={handlePointerCancel}
            >
              <div className="tab-overview-slot-header">
                <span className="tab-overview-slot-label">
                  {slot.position}:{slot.window.name || `Tab ${slot.position}`}
                </span>
                <button
                  type="button"
                  className="tab-overview-slot-close"
                  title="Close tab"
                  aria-label={`Close tab ${slot.position}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    send({ type: 'CLOSE_TAB', windowId: slot.window.id });
                  }}
                >
                  ✕
                </button>
              </div>
              {/* The active tab's frame is the FLIP target: the live grid is
                  drawn over it, so its wireframe only shows through the
                  zoom animation. */}
              <div className="tab-overview-frame" aria-hidden="true">
                {slot.boxes.map((box) => {
                  // The pane's screen at its natural cell size, scaled into
                  // the box (each axis on its own, so it fills the box the
                  // way the pane fills its share of the tab).
                  const naturalW = box.cols * charWidth;
                  const naturalH = box.rows * charHeight;
                  const shot =
                    frameSize && naturalW > 0 && naturalH > 0
                      ? {
                          width: naturalW,
                          height: naturalH,
                          transform: `scale(${(frameSize.width * box.width) / 100 / naturalW}, ${
                            (frameSize.height * box.height) / 100 / naturalH
                          })`,
                        }
                      : null;
                  return (
                    <div
                      key={box.paneId}
                      className={`tab-overview-box${box.active ? ' is-active' : ''}`}
                      style={{
                        left: `${box.left}%`,
                        top: `${box.top}%`,
                        width: `${box.width}%`,
                        height: `${box.height}%`,
                      }}
                    >
                      {shot ? (
                        <div className="tab-overview-shot" style={shot}>
                          <Terminal
                            content={box.content}
                            width={box.cols}
                            height={box.rows}
                            isActive={false}
                            paneId={box.paneId}
                          />
                        </div>
                      ) : (
                        <span className="tab-overview-box-label">{box.label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div
          id={`tab-overview-slot-${slots.length}`}
          className={`tab-overview-slot tab-overview-slot-new${
            selected === slots.length ? ' is-selected' : ''
          }${dropMarkerAt === slots.length ? ' is-drop-before' : ''}`}
          role="option"
          aria-selected={selected === slots.length}
          aria-label="New tab"
          data-testid="tab-overview-new"
          onClick={(e) => {
            e.stopPropagation();
            send({ type: 'TAB_OVERVIEW_ACTIVATE', index: slots.length });
          }}
        >
          <div className="tab-overview-slot-header">
            <span className="tab-overview-slot-label">New tab</span>
          </div>
          <div className="tab-overview-frame tab-overview-frame-new" aria-hidden="true">
            <span className="tab-overview-plus">+</span>
          </div>
        </div>
      </div>
    </div>
  );
}
