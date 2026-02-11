/**
 * FloatPane - Simple centered floating pane with backdrop
 *
 * - Always centered on screen
 * - Semi-transparent backdrop that closes float on click
 * - No dragging, resizing, or grouping
 * - Green border on all sides when active
 */

import { useCallback } from 'react';
import { Terminal } from './Terminal';
import {
  useAppSend,
  usePane,
  useAppSelector,
  selectCharSize,
  selectContainerSize,
} from '../machines/AppContext';
import type { FloatPaneState } from '../machines/types';

interface FloatPaneProps {
  floatState: FloatPaneState;
}

export function FloatPane({ floatState }: FloatPaneProps) {
  const send = useAppSend();
  const pane = usePane(floatState.paneId);
  const { charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'CLOSE_FLOAT', paneId: floatState.paneId });
    },
    [send, floatState.paneId]
  );

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Don't close when clicking on the float itself
    send({ type: 'FOCUS_PANE', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  if (!pane) return null;

  const title = pane.borderTitle || pane.tmuxId;
  const terminalRows = Math.floor(floatState.height / charHeight);

  // Center the float pane
  const floatWidth = floatState.width;
  const floatHeight = floatState.height + 28; // Add header height
  const left = Math.max(0, (containerWidth - floatWidth) / 2);
  const top = Math.max(0, (containerHeight - floatHeight) / 2);

  return (
    <div
      className="float-pane"
      style={{
        position: 'absolute',
        left,
        top,
        width: floatWidth,
        zIndex: 1000,
      }}
      onClick={handleClick}
    >
      {/* Header - simple, no drag */}
      <div className="float-header">
        <span className="float-title">{title}</span>
        <button className="float-close" onClick={handleClose} title="Close">
          ×
        </button>
      </div>

      {/* Terminal content with border */}
      <div
        className="float-content"
        style={{ width: floatWidth, height: floatState.height }}
      >
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
  );
}

/**
 * FloatContainer - Container for float panes with backdrop
 */
export function FloatContainer() {
  const send = useAppSend();
  const floatPanes = useAppSelector((ctx) => ctx.floatPanes);

  const visibleFloats = Object.values(floatPanes);

  const handleBackdropClick = useCallback(() => {
    // Close all float panes when clicking backdrop
    visibleFloats.forEach((f) => {
      send({ type: 'CLOSE_FLOAT', paneId: f.paneId });
    });
  }, [send, visibleFloats]);

  if (visibleFloats.length === 0) return null;

  return (
    <div className="float-overlay">
      {/* Semi-transparent backdrop */}
      <div className="float-backdrop" onClick={handleBackdropClick} />

      {/* Float panes */}
      {visibleFloats.map((floatState) => (
        <FloatPane key={floatState.paneId} floatState={floatState} />
      ))}
    </div>
  );
}
