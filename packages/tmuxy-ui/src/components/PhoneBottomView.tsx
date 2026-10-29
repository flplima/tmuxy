/**
 * PhoneBottomView — what a phone shows under the key row: the tabs/panes
 * tree, or, after a sideways swipe on it, the side pane — the pinned terminal
 * the desktop keeps in its right column (`sidebar-right`, see Sidebar.tsx),
 * the same window, created the same way on first use. Another sideways swipe
 * flips back. The `phone` state slice owns which is in front.
 *
 * The swipe is a slide, as a swipe between tabs is: the view follows the
 * finger, the other view rides beside it on the side the finger pulls from,
 * and on release the pair settles on the tab slide's own curve — on to the
 * other view when the slide commits, back to rest when it does not
 * (utils/bottomSlide.ts). The track moves on an inline transform while the
 * finger has it; React only mounts and unmounts the view riding beside.
 *
 * The side pane is drawn in the chrome's small type (selectPhoneDockCellMetrics)
 * and sized to this view: the box is measured here and the cell count it
 * holds is written to the pane's window (SET_PHONE_DOCK_SIZE), which is what
 * the backend sizes the pane from — the desktop's drag writes the same tags.
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SidebarTree } from './SidebarTree';
import { TerminalPane } from './TerminalPane';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectPhoneBottomView, selectPhoneDockCellMetrics } from '../machines/selectors/layout';
import { selectRightSidebarPane } from '../machines/selectors/panesAndSidebars';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../machines/constants';
import { cellMetricsStyle } from '../utils/cellMetrics';
import { SWIPE_EASING } from '../utils/gestures';
import {
  neighborSide,
  otherView,
  releaseBottomSlide,
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
  // The view riding beside the one in front, and the side it is on: mounted
  // for the slide and gone once it has settled.
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
  // slide and anything else is left to the tree's scroll or the pane's own
  // gestures. A finger that lands while a release is still settling waits
  // for it: the settle is short, and the slide it ends is the one it ends.
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length !== 1 || settling) {
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

  const onTouchMove = useCallback((e: React.TouchEvent) => {
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
    moveTrack(dx, 'none');
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start || intentRef.current !== 'swipe') return;
      const t = e.changedTouches[0];
      const dx = t ? t.clientX - start.x : dxRef.current;
      const { target, flips, settleMs } = releaseBottomSlide(
        dx,
        releaseSpeed(samplesRef.current),
        widthRef.current,
      );
      setSettling(true);
      moveTrack(target, `transform ${settleMs}ms ${SWIPE_EASING}`);
      settleTimerRef.current = window.setTimeout(() => {
        settleTimerRef.current = null;
        if (flips) send({ type: 'SET_PHONE_BOTTOM_VIEW', view: otherView(view) });
        moveTrack(0, 'none');
        setNeighbor(null);
        setSettling(false);
      }, settleMs);
    },
    [send, view],
  );

  const panel = (which: BottomView) =>
    which === 'tree' ? (
      <div className="phone-tree">
        <SidebarTree focused={false} />
      </div>
    ) : (
      <PhoneDock />
    );

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
      <div ref={trackRef} className="phone-bottom-track">
        <div className="phone-bottom-panel">{panel(view)}</div>
        {neighbor && (
          <div className={`phone-bottom-panel phone-bottom-panel-${neighbor}`} aria-hidden="true">
            {panel(otherView(view))}
          </div>
        )}
      </div>
    </div>
  );
});

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
