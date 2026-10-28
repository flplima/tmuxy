/**
 * PhoneBottomView — what a phone shows under the key row: the tabs/panes
 * tree, or, after a sideways swipe on it, the dock — the pinned terminal the
 * desktop keeps in its right column (`sidebar-right`, see Sidebar.tsx), the
 * same window, created the same way on first use. Another sideways swipe
 * flips back. The `phone` state slice owns which is in front.
 *
 * The dock's pane is drawn in the chrome's small type (selectPhoneDockCellMetrics)
 * and sized to this view: the box is measured here and the cell count it
 * holds is written to the dock's window (SET_PHONE_DOCK_SIZE), which is what
 * the backend sizes the pane from — the desktop's drag writes the same tags.
 */

import { memo, useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { SidebarTree } from './SidebarTree';
import { TerminalPane } from './TerminalPane';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectPhoneBottomView, selectPhoneDockCellMetrics } from '../machines/selectors/layout';
import { selectRightSidebarPane } from '../machines/selectors/panesAndSidebars';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../machines/constants';
import { cellMetricsStyle } from '../utils/cellMetrics';
import { decideIntent, type TouchPoint } from '../utils/touchGesture';

/** A sideways swipe shorter than this is a scroll that wandered. */
const FLIP_MIN_PX = 60;

export const PhoneBottomView = memo(function PhoneBottomView() {
  const send = useAppSend();
  const view = useAppSelector(selectPhoneBottomView);
  const startRef = useRef<TouchPoint | null>(null);

  // A sideways swipe anywhere on the view flips it. Only the start and the
  // end are read: the tree scrolls and the dock's pane scrolls or selects on
  // the moves in between, and neither needs to know.
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    startRef.current = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: 0 } : null;
  }, []);
  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const end = { x: t.clientX, y: t.clientY, t: 0 };
      if (decideIntent(start, end, true) !== 'swipe') return;
      if (Math.abs(end.x - start.x) < FLIP_MIN_PX) return;
      send({ type: 'SET_PHONE_BOTTOM_VIEW', view: view === 'tree' ? 'dock' : 'tree' });
    },
    [send, view],
  );

  return (
    <div
      className={`phone-bottom phone-bottom-${view}`}
      data-testid="phone-bottom"
      data-view={view}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {view === 'tree' ? (
        <div className="phone-tree">
          <SidebarTree focused={false} />
        </div>
      ) : (
        <PhoneDock />
      )}
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
