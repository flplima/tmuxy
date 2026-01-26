/**
 * FloatPane - Floating pane component with drag and resize support
 *
 * Renders as an overlay above the tiled pane layout.
 * Supports drag to move, edge drag to resize, and pin to stay visible.
 */

import { useCallback, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import {
  useAppSend,
  usePane,
  useAppSelector,
  selectCharSize,
} from '../machines/AppContext';
import type { FloatPaneState } from '../machines/types';

interface FloatPaneProps {
  floatState: FloatPaneState;
}

export function FloatPane({ floatState }: FloatPaneProps) {
  const send = useAppSend();
  const pane = usePane(floatState.paneId);
  const { charWidth, charHeight } = useAppSelector(selectCharSize);

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);

  // Resize state
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{
    edge: string;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
    startPosX: number;
    startPosY: number;
  } | null>(null);

  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).classList.contains('float-close') ||
          (e.target as HTMLElement).classList.contains('float-pin')) {
        return;
      }

      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        startX: floatState.x,
        startY: floatState.y,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;
        const dx = moveEvent.clientX - dragStartRef.current.x;
        const dy = moveEvent.clientY - dragStartRef.current.y;
        send({
          type: 'MOVE_FLOAT',
          paneId: floatState.paneId,
          x: dragStartRef.current.startX + dx,
          y: dragStartRef.current.startY + dy,
        });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        dragStartRef.current = null;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [send, floatState.paneId, floatState.x, floatState.y]
  );

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);
      resizeStartRef.current = {
        edge,
        startX: e.clientX,
        startY: e.clientY,
        startWidth: floatState.width,
        startHeight: floatState.height,
        startPosX: floatState.x,
        startPosY: floatState.y,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!resizeStartRef.current) return;
        const { edge, startX, startY, startWidth, startHeight, startPosX, startPosY } = resizeStartRef.current;
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;

        let newWidth = startWidth;
        let newHeight = startHeight;
        let newX = startPosX;
        let newY = startPosY;

        if (edge.includes('e')) newWidth = Math.max(200, startWidth + dx);
        if (edge.includes('w')) {
          newWidth = Math.max(200, startWidth - dx);
          newX = startPosX + dx;
        }
        if (edge.includes('s')) newHeight = Math.max(100, startHeight + dy);
        if (edge.includes('n')) {
          newHeight = Math.max(100, startHeight - dy);
          newY = startPosY + dy;
        }

        send({
          type: 'RESIZE_FLOAT',
          paneId: floatState.paneId,
          width: newWidth,
          height: newHeight,
        });
        send({
          type: 'MOVE_FLOAT',
          paneId: floatState.paneId,
          x: newX,
          y: newY,
        });
      };

      const handleMouseUp = () => {
        setIsResizing(false);
        resizeStartRef.current = null;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [send, floatState.paneId, floatState.width, floatState.height, floatState.x, floatState.y]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'CLOSE_FLOAT', paneId: floatState.paneId });
    },
    [send, floatState.paneId]
  );

  const handlePin = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (floatState.pinned) {
        send({ type: 'UNPIN_FLOAT', paneId: floatState.paneId });
      } else {
        send({ type: 'PIN_FLOAT', paneId: floatState.paneId });
      }
    },
    [send, floatState.paneId, floatState.pinned]
  );

  const handleEmbed = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'EMBED_FLOAT', paneId: floatState.paneId });
    },
    [send, floatState.paneId]
  );

  const handleClick = useCallback(() => {
    send({ type: 'FOCUS_PANE', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  if (!pane) return null;

  const title = pane.borderTitle || pane.tmuxId;
  const terminalRows = Math.floor(floatState.height / charHeight);
  void charWidth; // Used for terminal dimensions

  return (
    <div
      className={`float-pane ${isDragging ? 'float-dragging' : ''} ${isResizing ? 'float-resizing' : ''} ${floatState.pinned ? 'float-pinned' : ''}`}
      style={{
        position: 'absolute',
        left: floatState.x,
        top: floatState.y,
        width: floatState.width,
        height: floatState.height + 24, // Add header height
        zIndex: 1000,
      }}
      onClick={handleClick}
    >
      {/* Resize handles */}
      <div className="float-resize float-resize-n" onMouseDown={(e) => handleResizeMouseDown(e, 'n')} />
      <div className="float-resize float-resize-s" onMouseDown={(e) => handleResizeMouseDown(e, 's')} />
      <div className="float-resize float-resize-e" onMouseDown={(e) => handleResizeMouseDown(e, 'e')} />
      <div className="float-resize float-resize-w" onMouseDown={(e) => handleResizeMouseDown(e, 'w')} />
      <div className="float-resize float-resize-ne" onMouseDown={(e) => handleResizeMouseDown(e, 'ne')} />
      <div className="float-resize float-resize-nw" onMouseDown={(e) => handleResizeMouseDown(e, 'nw')} />
      <div className="float-resize float-resize-se" onMouseDown={(e) => handleResizeMouseDown(e, 'se')} />
      <div className="float-resize float-resize-sw" onMouseDown={(e) => handleResizeMouseDown(e, 'sw')} />

      {/* Header */}
      <div className="float-header" onMouseDown={handleHeaderMouseDown}>
        <span className="float-title">{title}</span>
        <div className="float-buttons">
          <button
            className="float-embed"
            onClick={handleEmbed}
            title="Embed into tiled layout"
          >
            ⊏
          </button>
          <button
            className={`float-pin ${floatState.pinned ? 'float-pin-active' : ''}`}
            onClick={handlePin}
            title={floatState.pinned ? 'Unpin' : 'Pin'}
          >
            📌
          </button>
          <button className="float-close" onClick={handleClose} title="Close">
            ×
          </button>
        </div>
      </div>

      {/* Terminal content */}
      <div className="float-content" style={{ width: floatState.width, height: floatState.height }}>
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
 * FloatContainer - Container for all float panes
 * Shows visible float panes as overlay
 */
export function FloatContainer() {
  const floatViewVisible = useAppSelector((ctx) => ctx.floatViewVisible);
  const floatPanes = useAppSelector((ctx) => ctx.floatPanes);

  // Get visible floats (all when view is visible, only pinned otherwise)
  const visibleFloats = Object.values(floatPanes).filter(
    (f) => floatViewVisible || f.pinned
  );

  if (visibleFloats.length === 0) return null;

  return (
    <div className="float-container" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {visibleFloats.map((floatState) => (
        <div key={floatState.paneId} style={{ pointerEvents: 'auto' }}>
          <FloatPane floatState={floatState} />
        </div>
      ))}
    </div>
  );
}
