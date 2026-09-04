/**
 * SidebarColumn — the chrome both sidebars share.
 *
 * A sidebar is a full-height, fixed-width column holding ONE REAL TMUX PANE,
 * broken out into its own tagged window exactly the way a float is (see
 * `breakOutTaggedWindow`). The left column runs `tmuxy widget tree`, the right
 * a shell; everything else about them — width, focus cue, the pane rendering
 * below — is the same, and lives here.
 *
 * Two layouts, chosen by `selectSidebarLayout`:
 *
 *  - DOCKED (the normal case): a real flex sibling of the pane area, NOT an
 *    overlay. Because the pane container flexes into the remaining width, its
 *    ResizeObserver reports the reduced size and tmux re-tiles the panes to fit;
 *    panes never render underneath a sidebar. The column carries no header of
 *    its own — its title lives in the app header, aligned to the same divider.
 *  - OVERLAY (a window too narrow to share): the column floats over the panes
 *    and the tab strip above them, with a backdrop, and grows its own one-row
 *    header — there is no app-header room left to put the title in.
 *
 * Geometry is a contract with the backend: `apply_client_size`
 * (tmuxy-core/src/control_mode/monitor.rs) sizes a `sidebar-*` window to
 * `sidebar_dock::size`, so the column here must be drawn at exactly
 * LEFT/RIGHT_SIDEBAR_COLS × targetRows cells or the pane would wrap at a width
 * the UI doesn't render.
 */

import { memo, useCallback, type CSSProperties } from 'react';
import { TerminalPane } from './TerminalPane';
import { getWidget } from './widgets';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectSidebarCellMetrics,
} from '../machines/AppContext';
import { cellMetricsStyle } from '../utils/cellMetrics';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import type { TmuxPane } from '../machines/types';

interface SidebarColumnProps {
  /** Which edge the column docks to; drives the border and focus cue side. */
  side: 'left' | 'right';
  /** Column width in pixels, derived from the cell grid by the caller. */
  width: number;
  /** True while the column floats over the panes instead of docking beside them. */
  overlay: boolean;
  focused: boolean;
  /** The column's pane, or null while its window is still being broken out. */
  pane: TmuxPane | null;
  /** The column was asked to open but its pane never appeared (see SIDEBAR_START_TIMEOUT). */
  startFailed: boolean;
  /** Header label in overlay layout — the app header has no room for it there. */
  title: string;
  /** Focus request from a click anywhere in the column. */
  onFocus: () => void;
  /** The overlay header's close button (and the failure state's). */
  onClose: () => void;
  /** Tooltip/aria text for the close button (the two mean different things). */
  closeLabel: string;
  testId: string;
}

export const SidebarColumn = memo(function SidebarColumn({
  side,
  width,
  overlay,
  focused,
  pane,
  startFailed,
  title,
  onFocus,
  onClose,
  closeLabel,
  testId,
}: SidebarColumnProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFocus();
    },
    [onFocus],
  );

  // The dock's terminal runs in the sidebar font, on a cell grid scaled to it
  // (selectSidebarCellMetrics): the font and the --cell-w / --cell-gap every
  // cell-addressed box reads are scoped to this column.
  const dock = useAppSelector(selectSidebarCellMetrics);
  const cellVars =
    side === 'right'
      ? ({
          '--tmuxy-font-size': `${dock.fontSize}px`,
          ...cellMetricsStyle(dock),
        } as CSSProperties)
      : undefined;

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      // Without this the click also lands on the column and focuses what we
      // are about to close.
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );

  return (
    <aside
      className={`sidebar-column sidebar-column-${side}${focused ? ' is-focused' : ''}${
        overlay ? ' is-overlay' : ''
      }`}
      // Pinned on all four axes: `flex: 0 0` alone still lets a wide child
      // stretch the column, which would silently desync it from the cell count
      // the backend sized the pane to.
      style={{ flex: `0 0 ${width}px`, width, minWidth: width, maxWidth: width, ...cellVars }}
      onClick={handleClick}
      data-testid={testId}
    >
      {overlay && (
        <div className="sidebar-header">
          <span className="sidebar-header-title">{title}</span>
          <button
            type="button"
            className="sidebar-header-close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={handleClose}
          >
            <SidebarGlyph side={side} />
          </button>
        </div>
      )}
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

/**
 * The panel-outline glyph that marks a sidebar, with the controlled edge filled
 * in. Shared by the header toggles and the overlay header's close button, so
 * "the thing that opens this" and "the thing that closes it" read as one
 * control.
 */
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

/** What each column's pane runs — shown when the pane failed to come up. */
const START_COMMAND = { left: 'tmuxy widget tree', right: 'the default shell' } as const;

/**
 * Render a sidebar's pane.
 *
 * The LEFT column is the tree widget by definition: a `sidebar-left` window IS
 * the tree, so the registered `tree` component is rendered directly instead of
 * detecting it from the pane's screen text. (Detection depended on the marker
 * line `__TMUXY_WIDGET__:tree` fitting on one row; below 22 columns it wrapped
 * and the column fell back to a raw terminal.)
 *
 * The RIGHT column is a terminal pane with the same interaction layer a tiled
 * pane has — wheel and drag enter client-side copy mode, right-click selects a
 * word, touch scrolls — minus the header (a sidebar's title lives in the app
 * header, and in overlay layout in its own header above).
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
  const send = useAppSend();
  const { charHeight } = useAppSelector(selectCharSize);

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
    // The window is being broken out — one round trip, not a failure state.
    return <div className="sidebar-placeholder">starting…</div>;
  }

  if (side === 'left') {
    const Tree = getWidget('tree')!;
    return (
      <Tree
        paneId={pane.tmuxId}
        widgetName="tree"
        lines={[]}
        lastLine=""
        rawContent={pane.content}
        writeStdin={(data: string) => send({ type: 'WRITE_TO_PANE', paneId: pane.tmuxId, data })}
        width={pane.width}
        height={pane.height}
      />
    );
  }

  return (
    // Height is pinned to the row count the backend sized the pane to, so the
    // rendered grid and tmux's idea of the pane can't drift apart.
    <div
      className="sidebar-terminal"
      style={{ height: pane.height * charHeight }}
      data-pane-id={pane.tmuxId}
    >
      <TerminalPane paneId={pane.tmuxId} chrome="none" isActive={focused} />
    </div>
  );
}
