/**
 * Geometry is a contract with the backend: `size_windows`
 * (tmuxy-core/src/control_mode/monitor_core/sizing.rs) sizes a `sidebar-*`
 * window to `sidebar_dock::cols`, so the column must be drawn at exactly that
 * many cells (LEFT/RIGHT_SIDEBAR_COLS by default) or the pane would wrap at a
 * width the UI doesn't render.
 */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { TerminalPane } from './terminal/TerminalPane';
import { SidebarTree } from './SidebarTree';
import { useAppSelector } from '../machines/appHooks';
import { selectSidebarCellMetrics } from '../machines/selectors/layout';
import { cellMetricsStyle } from '../infra/dom/cellMetrics';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import type { TmuxPane } from '../domain/client';

interface SidebarColumnProps {
  side: 'left' | 'right';
  /** px */
  width: number;
  focused: boolean;
  /** The column's pane, or null while its window is still being broken out. */
  pane: TmuxPane | null;
  /** The column was asked to open but its pane never appeared (see SIDEBAR_START_TIMEOUT). */
  startFailed: boolean;
  /** Shown over the panes for a hover, not docked beside them (useSidebarPeek). */
  peek?: boolean;
  onFocus: () => void;
  /** The failure state's close button. */
  onClose: () => void;
  testId: string;
}

export const SidebarColumn = memo(function SidebarColumn({
  side,
  width,
  focused,
  pane,
  startFailed,
  peek = false,
  onFocus,
  onClose,
  testId,
}: SidebarColumnProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFocus();
    },
    [onFocus],
  );

  const dock = useAppSelector(selectSidebarCellMetrics);
  const cellVars =
    side === 'right'
      ? ({
          '--tmuxy-font-size': `${dock.fontSize}px`,
          '--line-height-terminal': `${dock.lineHeight}px`,
          ...cellMetricsStyle(dock),
        } as CSSProperties)
      : undefined;

  return (
    <aside
      className={`sidebar-column sidebar-column-${side}${focused ? ' is-focused' : ''}${
        peek ? ' is-peek' : ''
      }`}
      // The width is a custom property, not the width itself, so the
      // stylesheet can pin the column to it on all four axes: `flex: 0 0`
      // alone still lets a wide child stretch the column, silently desyncing
      // it from the cell count the backend sized the pane to.
      style={{ '--sidebar-width': `${width}px`, ...cellVars } as CSSProperties}
      onClick={handleClick}
      data-testid={testId}
    >
      <div className="sidebar-body">
        <SidebarPane
          side={side}
          pane={pane}
          focused={focused}
          startFailed={startFailed}
          onClose={onClose}
        />
      </div>
      <SidebarResizeHandle side={side} windowId={pane?.windowId ?? null} width={width} />
    </aside>
  );
});

export function SidebarGlyph({ side }: { side: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" strokeWidth="1.3" />
      <rect
        x={side === 'left' ? 2 : 9.5}
        y="2.75"
        width="4.5"
        height="10.5"
        rx="1.5"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

const START_COMMAND = { left: 'tmuxy widget tree', right: 'the default shell' } as const;

/**
 * A `sidebar-left` window IS the tree, so `SidebarTree` is rendered directly
 * instead of waiting for the `tree` widget's marker to reach the screen; the
 * registered widget is for a `tmuxy widget tree` run in an ordinary pane.
 */
function SidebarPane({
  side,
  pane,
  focused,
  startFailed,
  onClose,
}: {
  side: 'left' | 'right';
  pane: TmuxPane | null;
  focused: boolean;
  startFailed: boolean;
  onClose: () => void;
}) {
  const dock = useAppSelector(selectSidebarCellMetrics);
  const dockCell = useMemo(
    () => ({ width: dock.cellWidth, height: dock.lineHeight }),
    [dock.cellWidth, dock.lineHeight],
  );

  if (!pane) {
    if (startFailed) {
      return (
        <div className="sidebar-start-failed" role="alert" data-testid={`sidebar-${side}-failed`}>
          <p className="sidebar-start-failed-title">
            The {side === 'left' ? 'tree' : 'terminal'} pane did not start.
          </p>
          <p>
            tmux was asked to run <code>{START_COMMAND[side]}</code> in a new pane and it exited at
            once or never appeared. Check that the tmuxy CLI is on this server&apos;s PATH.
          </p>
          <button
            type="button"
            className="sidebar-start-failed-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            Close
          </button>
        </div>
      );
    }
    return <div className="sidebar-placeholder">starting…</div>;
  }

  if (side === 'left') return <SidebarTree focused={focused} />;

  return (
    // Pinned to the row count the backend sized the pane to.
    <div
      className="sidebar-terminal"
      style={{ height: pane.height * dock.lineHeight }}
      data-pane-id={pane.tmuxId}
    >
      <TerminalPane paneId={pane.tmuxId} chrome="none" isActive={focused} cellSize={dockCell} />
    </div>
  );
}
