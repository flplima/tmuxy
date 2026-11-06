/**
 * What a phone shows under the key row: the tabs/panes tree, or, after a
 * sideways swipe, the side pane (the desktop's `sidebar-right`). The swipe is a
 * slide on the tab slide's curve (bottomSlide.ts).
 *
 * The side pane is sized to this view: the cell count the measured box holds
 * is written to the pane's window (SET_PHONE_DOCK_SIZE), which is what the
 * backend sizes the pane from; the desktop's drag writes the same tags.
 */

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { SidebarTree } from '../SidebarTree';
import { TerminalPane } from '../terminal/TerminalPane';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectPhoneBottomView, selectPhoneDockCellMetrics } from '../../machines/selectors/layout';
import { selectRightSidebarPane } from '../../machines/selectors/panesAndSidebars';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../../machines/constants';
import { cellMetricsStyle } from '../../infra/dom/cellMetrics';
import { SWIPE_EASING } from '../../machines/gestures/gestures';
import {
  neighborSide,
  otherView,
  releaseBottomSlide,
  type BottomView,
  type NeighborSide,
} from './bottomSlide';
import { decideIntent, releaseSpeed, type TouchIntent, type TouchPoint } from './touchGesture';

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
