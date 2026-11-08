import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppSend, useAppSelector, useAppSelectorShallow } from '../machines/appHooks';
import { selectVisibleWindows } from '../machines/selectors/panesAndSidebars';
import { selectPanes, selectContainerSize, selectCharSize } from '../machines/selectors/layout';
import { selectTabOverviewCols } from '../machines/selectors/ui';
import { overviewSlots, stillPanes } from '../domain/tabOverview';
import { LogProfiler } from './renderLog';
import { TabOverviewSlots } from './TabOverviewSlot';
import { useTabStill } from './useTabStill';
import { useReorderDrag } from './useReorderDrag';
import { nudgeCursorAnchor } from './terminal/cursorAnchor';
import type { WindowId } from '../domain/ids';

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
  const snapshot = useTabStill(livePanes, true);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const cols = useAppSelector(selectTabOverviewCols);
  // The activate helpers are stable callbacks: they must see the slots of the
  // render the click happened in, not the ones they closed over.
  const slotsRef = useRef<ReturnType<typeof overviewSlots>>([]);
  /**
   * The card the user picked: the FLIP target follows it instead of the
   * active tab's card until the overview closes a frame later.
   */
  const [opening, setOpening] = useState<{ index: number; windowId: WindowId } | null>(null);
  const slots = useMemo(
    () => overviewSlots(windows, stillPanes(livePanes, snapshot)),
    [windows, livePanes, snapshot],
  );
  slotsRef.current = slots;
  // Every frame has the same size (one grid track, one aspect ratio), so one
  // measurement serves them all.
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // The grid wraps, so a drop reads the nearest row first.
  const reorder = useReorderDrag({
    containerRef: gridRef,
    cardSelector: '.tab-overview-slot[data-window-id]',
    axis: 'xy',

    onReorder: (windowId, toIndex) => send({ type: 'REORDER_TAB', windowId, toIndex }),
  });
  const { dragging } = reorder;
  // The current tab's frame scrolls, so the live grid is re-aimed on every scroll.
  const [scrollTop, setScrollTop] = useState(0);
  const measuredScrollRef = useRef(0);

  // Not scrollIntoView: it would also scroll the overflow-hidden ancestors the
  // live grid is positioned in.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const card = grid?.querySelector<HTMLElement>(`#tab-overview-slot-${selected}`);
    if (!grid || !card) return;
    const pad = parseFloat(getComputedStyle(grid).paddingTop) || 0;
    const g = grid.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (c.top < g.top + pad) grid.scrollTop -= g.top + pad - c.top;
    else if (c.bottom > g.bottom - pad) grid.scrollTop += c.bottom - (g.bottom - pad);
  }, [selected, cols]);

  // FLIP: scale the live pane grid into the current tab's frame. While the
  // current tab's card is dragged, the frame's measured box already includes
  // the drag translate, so re-measuring on every move is enough — with the
  // grid's own transition off, or it would trail the pointer.
  const draggingActive = dragging?.windowId === activeWindowId ? dragging : null;
  const dragOffset = draggingActive ? `${draggingActive.dx},${draggingActive.dy}` : '';
  useLayoutEffect(() => {
    const root = rootRef.current;
    const container = root?.parentElement;
    // A scroll is a re-aim too: the grid must stay glued to its card, not
    // chase it through a transition.
    const scrolled = scrollTop !== measuredScrollRef.current;
    measuredScrollRef.current = scrollTop;
    if (container) {
      // Moving onto the picked card is a re-aim, not a move to watch: it must
      // land in the frame it is written in, or the grid would slide across
      // the overview on its way there.
      if (dragOffset || opening || scrolled) {
        container.style.setProperty('--tab-overview-motion', '0s');
      } else container.style.removeProperty('--tab-overview-motion');
    }
    const layout = container?.querySelector<HTMLElement>('.pane-layout');
    const frame = root?.querySelector<HTMLElement>(
      opening
        ? `.tab-overview-slot[data-window-id="${opening.windowId}"] .tab-overview-frame`
        : '.tab-overview-slot.is-active .tab-overview-frame',
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
    // Moving onto the picked card has to be COMMITTED here, while the
    // transition is off. Left to the next style recalculation the duration
    // would already be back, and the browser would animate the re-aim itself
    // — the grid sliding across the overview, with the grow that follows
    // starting from wherever that slide had got to.
    if (opening || scrolled) void getComputedStyle(layout).transform;
    // The scroll re-aim is committed; give the duration back so closing the
    // overview still grows the grid out of its card.
    if (scrolled && !dragOffset && !opening) {
      container.style.removeProperty('--tab-overview-motion');
    }
    // The grid — and the cursor anchor inside it — just moved without any
    // pane rendering; the cursor overlay has to be told.
    nudgeCursorAnchor();
  }, [
    slots.length,
    containerWidth,
    containerHeight,
    activeWindowId,
    frameSize,
    dragOffset,
    opening,
    cols,
    scrollTop,
  ]);

  // The grid is on the picked card and painted there; hand the clock back and
  // close, so the grow starts from the card that was clicked.
  useEffect(() => {
    if (!opening) return;
    // Two frames, not one: an effect's rAF runs in the NEXT frame's callback
    // phase, which is still before that frame's style recalculation, so the
    // move onto the card would not have been drawn yet.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        rootRef.current?.parentElement?.style.removeProperty('--tab-overview-motion');
        send({ type: 'TAB_OVERVIEW_ACTIVATE', index: opening.index });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [opening, send]);

  /**
   * Grows the grid out of THAT slot, not the active tab's card. The move onto
   * it has to be committed and painted before the overview closes, or the
   * browser coalesces the two into one style change and the grow starts from
   * wherever the grid was parked.
   */
  const activateSlot = useCallback(
    (index: number) => {
      const slot = slotsRef.current[index];
      // The trailing "+" has no card to grow out of; it creates a tab.
      if (!slot) {
        send({ type: 'TAB_OVERVIEW_ACTIVATE', index });
        return;
      }
      setOpening({ index, windowId: slot.window.id });
    },
    [send],
  );

  const stateRef = useRef({ slots, selected, send, activateSlot });
  stateRef.current = { slots, selected, send, activateSlot };
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
      const { slots: s, selected: sel, send: dispatch, activateSlot: activate } = stateRef.current;
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
          activate(sel);
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
            if (s[index]) activate(index);
          }
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const aspect =
    containerWidth > 0 && containerHeight > 0 ? containerWidth / containerHeight : 16 / 9;

  return (
    <div
      ref={rootRef}
      className="tab-overview"
      role="dialog"
      aria-label="All tabs"
      data-testid="tab-overview"
      onClick={(e) => {
        if (e.target === e.currentTarget || e.target === gridRef.current) {
          send({ type: 'CLOSE_TAB_OVERVIEW' });
        }
      }}
    >
      <div
        ref={gridRef}
        className="tab-overview-grid"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        role="listbox"
        aria-label="Tabs"
        aria-keyshortcuts="Enter Delete"
        aria-activedescendant={`tab-overview-slot-${selected}`}
        style={
          {
            '--tab-overview-aspect': String(aspect),
            '--tab-overview-cols': String(cols),
            '--tab-overview-cols-narrow': String(Math.min(cols, 2)),
          } as React.CSSProperties
        }
      >
        <TabOverviewSlots
          slots={slots}
          activeWindowId={activeWindowId}
          selected={selected}
          frameSize={frameSize}
          charWidth={charWidth}
          charHeight={charHeight}
          reorder={reorder}
          activateSlot={activateSlot}
          send={send}
        />
      </div>
    </div>
  );
}
