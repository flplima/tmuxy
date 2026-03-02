/**
 * FloatPane - Floating pane overlay inside the pane container.
 *
 * Uses the same PaneHeader as regular panes (without group buttons).
 * Rendered inline (no portal) so the overlay stays within .pane-container.
 * Clicking the backdrop closes the float.
 */

import React, { useCallback } from 'react';
import { Terminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectContainerSize,
} from '../machines/AppContext';
import type { FloatPaneState } from '../machines/types';
import type { TmuxPane } from '../machines/types';

interface FloatPaneProps {
  floatState: FloatPaneState;
  zIndex?: number;
}

export function FloatPane({ floatState, zIndex = 1001 }: FloatPaneProps) {
  const send = useAppSend();
  const pane = useAppSelector((ctx) =>
    ctx.panes.find((p: TmuxPane) => p.tmuxId === floatState.paneId),
  );
  const { charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);

  const handleClose = useCallback(() => {
    send({ type: 'CLOSE_FLOAT', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      send({ type: 'FOCUS_PANE', paneId: floatState.paneId });
    },
    [send, floatState.paneId],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  if (!pane) return null;

  const terminalRows = Math.floor(floatState.height / charHeight);
  const floatWidth = floatState.width;
  const headerHeight = 24; // --pane-header-height
  const floatHeight = floatState.height + headerHeight;
  const left = Math.max(0, (containerWidth - floatWidth) / 2);
  const top = Math.max(0, (containerHeight - floatHeight) / 2);

  return (
    <div className="float-overlay" style={{ zIndex }} onClick={handleBackdropClick}>
      <div
        className="float-container"
        style={{ left, top, width: floatWidth, height: floatHeight }}
        onClick={handleClick}
        tabIndex={0}
        data-pane-id={pane.tmuxId}
      >
        <PaneHeader paneId={floatState.paneId} isFloat onFloatClose={handleClose} />
        <div className="float-content" style={{ height: floatState.height }}>
          <Terminal
            content={pane.content}
            cursorX={pane.cursorX}
            cursorY={pane.cursorY}
            isActive={pane.active}
            height={terminalRows}
            inMode={pane.inMode}
            copyCursorX={pane.copyCursorX}
            copyCursorY={pane.copyCursorY}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * FloatContainer - Container for all float panes.
 * Renders inline inside .pane-container so overlays stay scoped.
 */
export function FloatContainer() {
  const floatPanes = useAppSelector((ctx) => ctx.floatPanes);
  const visibleFloats = Object.values(floatPanes);

  if (visibleFloats.length === 0) return null;

  return (
    <>
      {visibleFloats.map((floatState, index) => (
        <FloatPane key={floatState.paneId} floatState={floatState} zIndex={1001 + index} />
      ))}
    </>
  );
}
