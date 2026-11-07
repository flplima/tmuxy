/**
 * PhoneDock — the phone's side pane: the pinned terminal the desktop keeps in
 * its right column (`sidebar-right`, see Sidebar.tsx), the same window,
 * created the same way on first use. Upright it is a view under the keys
 * (PhoneBottomView); held sideways it is the column right of the terminal,
 * there from the start (`autoStart`), and drawn as the desktop's column is:
 * no header, on the window's own background.
 *
 * It is drawn in the chrome's small type and sized to its box: the cell count
 * the measured box holds is written to the pane's window
 * (SET_PHONE_DOCK_SIZE), which is what the backend sizes the pane from — the
 * desktop's drag writes the same tags.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { TerminalPane } from '../terminal/TerminalPane';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectPhoneDockCellMetrics } from '../../machines/selectors/layout';
import { selectRightSidebarPane } from '../../machines/selectors/panesAndSidebars';
import { selectSidebarHoldsKeyboard } from '../../machines/selectors/keyboard';
import { SIDEBAR_MAX_COLS, SIDEBAR_MIN_COLS } from '../../machines/constants';
import { cellMetricsStyle } from '../../infra/dom/cellMetrics';

export function PhoneDock({ autoStart = false }: { autoStart?: boolean }) {
  const send = useAppSend();
  const pane = useAppSelector(selectRightSidebarPane);
  const focused = useAppSelector((ctx) => selectSidebarHoldsKeyboard(ctx, 'right'));
  const startFailed = useAppSelector((ctx) => ctx.sidebars.right.startFailed);
  const cell = useAppSelector(selectPhoneDockCellMetrics);
  const boxRef = useRef<HTMLDivElement>(null);

  // Held sideways the side pane is always on screen: break it out if it is
  // not there yet (the slice does nothing while one is starting or exists).
  const missing = !pane;
  useEffect(() => {
    if (autoStart && missing) send({ type: 'START_SIDEBAR', side: 'right' });
  }, [autoStart, missing, send]);

  // Re-armed when the pane appears, so the box measured while it was starting
  // is reported again.
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
