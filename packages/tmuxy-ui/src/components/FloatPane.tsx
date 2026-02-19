/**
 * FloatPane - Simple centered floating pane with backdrop
 *
 * - Always centered on screen
 * - Clicking backdrop, pressing Esc, or clicking × all close (kill) the float
 * - No dragging, resizing, or grouping
 * - Green border on all sides when active
 */

import React, { useCallback, useEffect } from 'react';
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
  zIndex?: number;
}

export function FloatPane({ floatState, zIndex = 1001 }: FloatPaneProps) {
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
    e.stopPropagation();
    send({ type: 'FOCUS_PANE', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  if (!pane) return null;

  const title = pane.borderTitle || pane.tmuxId;
  const terminalRows = Math.floor(floatState.height / charHeight);

  const floatWidth = floatState.width;
  const floatHeight = floatState.height + 28;
  const left = Math.max(0, (containerWidth - floatWidth) / 2);
  const top = Math.max(0, (containerHeight - floatHeight) / 2);

  return (
    <div
      className="float-modal"
      style={{
        position: 'absolute',
        left,
        top,
        width: floatWidth,
        zIndex,
      }}
      onClick={handleClick}
    >
      <div className="float-header">
        <span className="float-title">{title}</span>
        <button className="float-close" onClick={handleClose} title="Close">
          ×
        </button>
      </div>
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
 *
 * Renders whenever float panes exist. Clicking backdrop or pressing Esc
 * kills the topmost float. The × button kills that specific float.
 */
export function FloatContainer() {
  const send = useAppSend();
  const floatPanes = useAppSelector((ctx) => ctx.floatPanes);
  const visibleFloats = Object.values(floatPanes);

  const closeTopFloat = useCallback(() => {
    send({ type: 'CLOSE_TOP_FLOAT' });
  }, [send]);

  // Esc key closes the topmost float (capture phase to prevent reaching keyboard actor)
  useEffect(() => {
    if (visibleFloats.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        send({ type: 'CLOSE_TOP_FLOAT' });
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [visibleFloats.length, send]);

  if (visibleFloats.length === 0) return null;

  return (
    <div className="float-overlay">
      <div
        className="float-backdrop"
        style={{ zIndex: 1000 }}
        onClick={closeTopFloat}
      />
      {visibleFloats.map((floatState, index) => (
        <FloatPane
          key={floatState.paneId}
          floatState={floatState}
          zIndex={1001 + index}
        />
      ))}
    </div>
  );
}
