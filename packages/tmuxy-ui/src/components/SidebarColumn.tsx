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

import { memo, useCallback, useRef } from 'react';
import { Terminal } from './Terminal';
import { detectWidget, getWidget } from './widgets';
import { useAppSend, useAppSelector, selectCharSize } from '../machines/AppContext';
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
  /** Header label in overlay layout — the app header has no room for it there. */
  title: string;
  /** Focus request from a click anywhere in the column. */
  onFocus: () => void;
  /** The overlay header's close button. */
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
      style={{ flex: `0 0 ${width}px`, width, minWidth: width, maxWidth: width }}
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
        <SidebarPane pane={pane} focused={focused} />
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

/**
 * Render a sidebar's pane — the same widget-or-terminal split `Pane` does for a
 * tiled pane, minus the header (a sidebar's title lives in the app header, and
 * in overlay layout in its own header above).
 *
 * The widget path is what makes the left column work at all: its pane runs
 * `tmuxy widget tree`, so `detectWidget` resolves it to the registered `tree`
 * component instead of rasterising an empty terminal.
 */
function SidebarPane({ pane, focused }: { pane: TmuxPane | null; focused: boolean }) {
  const send = useAppSend();
  const { charHeight } = useAppSelector(selectCharSize);
  // Latch the classification across a transient empty capture, exactly as
  // `Pane` does: flipping widget→terminal on that gap remounts the subtree.
  const lastWidgetInfoRef = useRef<ReturnType<typeof detectWidget>>(null);

  if (!pane) {
    // The window is being broken out — one round trip, not a failure state.
    return <div className="sidebar-placeholder">starting…</div>;
  }

  let widgetInfo = detectWidget(pane.content);
  if (pane.content.length === 0) widgetInfo = lastWidgetInfoRef.current;
  else lastWidgetInfoRef.current = widgetInfo;

  if (widgetInfo) {
    const WidgetComponent = getWidget(widgetInfo.widgetName)!;
    const lines = widgetInfo.contentLines;
    return (
      <WidgetComponent
        paneId={pane.tmuxId}
        widgetName={widgetInfo.widgetName}
        lines={lines}
        lastLine={lines.filter((l) => l.trim()).pop() || ''}
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
      <Terminal
        content={pane.content}
        cursorX={pane.cursorX}
        cursorY={pane.cursorY}
        isActive={focused}
        width={pane.width}
        height={pane.height}
        inMode={pane.inMode}
        copyCursorX={pane.copyCursorX}
        copyCursorY={pane.copyCursorY}
        selectionPresent={pane.selectionPresent}
        selectionStartX={pane.selectionStartX}
        selectionStartY={pane.selectionStartY}
        cursorShape={pane.cursorShape}
        paneId={pane.tmuxId}
      />
    </div>
  );
}
