/**
 * PhoneBottomView — what a phone shows under the key row: three views side by
 * side, the app menu (PhoneMenu), the tabs/panes tree, and the side pane —
 * the pinned terminal the desktop keeps in its right column (`sidebar-right`,
 * see Sidebar.tsx), the same window, created the same way on first use. The
 * tree is in front to begin with; the tab bar along the bottom picks one, and
 * a sideways swipe moves to the view beside: right for the menu, left for the
 * side pane. The `phone` state slice owns which is in front. While the phone's
 * keyboard is up the tab bar makes way (hooks/usePhoneViewport.ts).
 *
 * The swipe is a slide, as a swipe between tabs is: the view follows the
 * finger, its neighbour rides beside it on the side the finger pulls from,
 * and on release the pair settles on the tab slide's own curve — on to the
 * neighbour when the slide commits, back to rest when it does not; past an
 * end, where there is no view, it moves a third as far and goes back
 * (utils/bottomSlide.ts). The track moves on an inline transform while the
 * finger has it; React only mounts and unmounts the view riding beside.
 *
 * A tap on the side pane brings the phone's keyboard up for it
 * (hooks/usePaneTouch.ts), and while it types there the terminal above gives
 * up its room first, so the side pane stays above the keyboard.
 *
 * The side pane is drawn in the chrome's small type (selectPhoneDockCellMetrics)
 * and sized to this view: the box is measured here and the cell count it
 * holds is written to the pane's window (SET_PHONE_DOCK_SIZE), which is what
 * the backend sizes the pane from — the desktop's drag writes the same tags.
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SidebarTree } from './SidebarTree';
import { TerminalPane } from './TerminalPane';
import { PhoneMenu } from './PhoneMenu';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectPhoneBottomView, selectPhoneDockCellMetrics } from '../machines/selectors/layout';
import { selectRightSidebarPane } from '../machines/selectors/panesAndSidebars';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../machines/constants';
import { cellMetricsStyle } from '../utils/cellMetrics';
import { SWIPE_EASING } from '../utils/gestures';
import {
  BOTTOM_VIEWS,
  neighborSide,
  neighborView,
  releaseBottomSlide,
  trackOffset,
  type BottomView,
  type NeighborSide,
} from '../utils/bottomSlide';
import {
  decideIntent,
  releaseSpeed,
  type TouchIntent,
  type TouchPoint,
} from '../utils/touchGesture';

/** Recent samples of a slide, for the speed it is released at. */
const SPEED_SAMPLES = 4;

export const PhoneBottomView = memo(function PhoneBottomView() {
  const send = useAppSend();
  const view = useAppSelector(selectPhoneBottomView);
  const trackRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<TouchPoint | null>(null);
  const intentRef = useRef<TouchIntent>('undecided');
  const widthRef = useRef(0);
  const dxRef = useRef(0);
  const samplesRef = useRef<TouchPoint[]>([]);
  const settleTimerRef = useRef<number | null>(null);
  // The side the finger pulls a neighbour from: the view there is mounted
  // for the slide and gone once it has settled (none past an end).
  const [neighbor, setNeighbor] = useState<NeighborSide | null>(null);
  const [settling, setSettling] = useState(false);

  const moveTrack = (dx: number, transition: string) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = transition;
    track.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
  };

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    },
    [],
  );

  // A finger lands undecided; past the slop, mostly sideways travel is a
  // slide and anything else is left to the view's scroll or the pane's own
  // gestures. A finger that lands while a release is still settling waits
  // for it: the settle is short, and the slide it ends is the one it ends.
  // The tab bar is tapped, never slid.
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      const onTabs = (e.target as Element | null)?.closest?.('.phone-tabs');
      if (!t || e.touches.length !== 1 || settling || onTabs) {
        startRef.current = null;
        return;
      }
      const start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
      startRef.current = start;
      intentRef.current = 'undecided';
      widthRef.current = e.currentTarget.getBoundingClientRect().width;
      dxRef.current = 0;
      samplesRef.current = [start];
    },
    [settling],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      const t = e.touches[0];
      if (!start || !t) return;
      const now = { x: t.clientX, y: t.clientY, t: e.timeStamp };
      if (intentRef.current === 'undecided') intentRef.current = decideIntent(start, now, true);
      if (intentRef.current !== 'swipe') return;
      const dx = now.x - start.x;
      dxRef.current = dx;
      const samples = samplesRef.current;
      samples.push(now);
      if (samples.length > SPEED_SAMPLES) samples.splice(0, samples.length - SPEED_SAMPLES);
      setNeighbor((side) => neighborSide(dx) ?? side);
      moveTrack(trackOffset(view, dx), 'none');
    },
    [view],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start || intentRef.current !== 'swipe') return;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : dxRef.current;
      const { target, next, settleMs } = releaseBottomSlide(
        view,
        dx,
        releaseSpeed(samplesRef.current),
        widthRef.current,
      );
      setSettling(true);
      moveTrack(target, `transform ${settleMs}ms ${SWIPE_EASING}`);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (next) send({ type: 'SET_PHONE_BOTTOM_VIEW', view: next });
        moveTrack(0, 'none');
        setNeighbor(null);
        setSettling(false);
      }, settleMs);
    },
    [send, view],
  );

  const panel = (which: BottomView) => {
    switch (which) {
      case 'menu':
        return <PhoneMenu />;
      case 'tree':
        return (
          <div className="phone-tree">
            <SidebarTree focused={false} />
          </div>
        );
      case 'dock':
        return <PhoneDock />;
    }
  };
  const beside = neighbor ? neighborView(view, neighbor) : null;

  return (
    <div
      className={`phone-bottom phone-bottom-${view}`}
      data-testid="phone-bottom"
      data-view={view}
      data-sliding={neighbor ? (settling ? 'settling' : 'tracking') : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="phone-bottom-stage">
        <div ref={trackRef} className="phone-bottom-track">
          <div className="phone-bottom-panel">{panel(view)}</div>
          {neighbor && beside && (
            <div className={`phone-bottom-panel phone-bottom-panel-${neighbor}`} aria-hidden="true">
              {panel(beside)}
            </div>
          )}
        </div>
      </div>
      <PhoneTabs
        view={view}
        onPick={(picked) => send({ type: 'SET_PHONE_BOTTOM_VIEW', view: picked })}
      />
    </div>
  );
});

const TAB_LABELS: Record<BottomView, string> = { menu: 'Menu', tree: 'Tree', dock: 'Side pane' };

/** Each view's icon: line strokes on a 16 × 16 grid, in the tab's colour. */
function TabIcon({ view }: { view: BottomView }) {
  return (
    <svg
      className="phone-tab-icon"
      width="20"
      height="20"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {view === 'menu' && <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />}
      {view === 'tree' && (
        <>
          <rect x="1.5" y="1.5" width="6" height="3" rx="1" />
          <path d="M4 4.5V12h3.5M4 8h3.5" />
          <rect x="8.5" y="6.5" width="6" height="3" rx="1" />
          <rect x="8.5" y="10.5" width="6" height="3" rx="1" />
        </>
      )}
      {view === 'dock' && (
        <>
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M4.5 6.5L6.5 8l-2 1.5M8.5 10h3" />
        </>
      )}
    </svg>
  );
}

/** The tab bar under the views, an icon over a name for each, left to right. */
function PhoneTabs({ view, onPick }: { view: BottomView; onPick: (view: BottomView) => void }) {
  return (
    <div className="phone-tabs" role="tablist" aria-label="Views">
      {BOTTOM_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="tab"
          className={`phone-tab${v === view ? ' is-active' : ''}`}
          aria-selected={v === view}
          data-view={v}
          onClick={() => onPick(v)}
        >
          <TabIcon view={v} />
          <span className="phone-tab-label">{TAB_LABELS[v]}</span>
        </button>
      ))}
    </div>
  );
}

function PhoneDock() {
  const send = useAppSend();
  const pane = useAppSelector(selectRightSidebarPane);
  const focused = useAppSelector((ctx) => ctx.rightSidebarFocused);
  const startFailed = useAppSelector((ctx) => ctx.rightSidebarStartFailed);
  const cell = useAppSelector(selectPhoneDockCellMetrics);
  const boxRef = useRef<HTMLDivElement>(null);

  // Size the dock's pane to the box it is drawn in, in its own cells — once
  // the pane exists to size (the observer is re-armed when it appears, so
  // the box measured while it was starting is reported again).
  const paneId = pane?.tmuxId ?? null;
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !paneId) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const cols = Math.max(
        SIDEBAR_MIN_COLS,
        Math.min(SIDEBAR_MAX_COLS, Math.floor(rect.width / cell.cellWidth)),
      );
      const rows = Math.max(1, Math.floor(rect.height / cell.lineHeight));
      send({ type: 'SET_PHONE_DOCK_SIZE', cols, rows });
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [send, paneId, cell.cellWidth, cell.lineHeight]);

  const style = {
    '--tmuxy-font-size': `${cell.fontSize}px`,
    '--line-height-terminal': `${cell.lineHeight}px`,
    ...cellMetricsStyle(cell),
  } as CSSProperties;

  return (
    <div ref={boxRef} className="phone-dock" style={style} data-testid="phone-dock">
      {pane ? (
        <TerminalPane
          paneId={pane.tmuxId}
          chrome="none"
          isActive={focused}
          cellSize={{ width: cell.cellWidth, height: cell.lineHeight }}
        />
      ) : startFailed ? (
        <div className="sidebar-start-failed" role="alert">
          <p className="sidebar-start-failed-title">The terminal pane did not start.</p>
        </div>
      ) : (
        <div className="sidebar-placeholder">starting…</div>
      )}
    </div>
  );
}
