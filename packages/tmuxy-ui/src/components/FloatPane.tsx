/**
 * FloatPane - Centered floating pane or edge-docked drawer
 *
 * Regular float: centered on screen with backdrop
 * Drawer (--left/--right/--top/--bottom): slides from edge, full height or width
 * Clicking backdrop, pressing Esc, or clicking × all close (kill) the float
 * Green border on all sides when active
 */

import React, { useCallback } from 'react';
import { Terminal } from './Terminal';
import { Modal } from './Modal';
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
  // Use raw panes list (not selectPreviewPanes) because float panes live in
  // non-active windows and selectPreviewPanes filters to activeWindowId only
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

  if (!pane) return null;

  const title = pane.borderTitle || pane.tmuxId;
  const { drawer } = floatState;

  // Drawer mode: dock to edge with full span on the perpendicular axis
  if (drawer) {
    const headerHeight = 28;
    const isHorizontal = drawer === 'left' || drawer === 'right';

    // For horizontal drawers: width from floatState, height = full container
    // For vertical drawers: height from floatState, width = full container
    const floatWidth = isHorizontal ? floatState.width : containerWidth;
    const floatHeight = isHorizontal ? containerHeight : floatState.height + headerHeight;
    const terminalHeight = floatHeight - headerHeight;
    const terminalRows = Math.floor(terminalHeight / charHeight);

    const containerStyle: React.CSSProperties = {};
    if (drawer === 'left') {
      containerStyle.left = 0;
      containerStyle.top = 0;
    } else if (drawer === 'right') {
      containerStyle.right = 0;
      containerStyle.top = 0;
    } else if (drawer === 'top') {
      containerStyle.left = 0;
      containerStyle.top = 0;
    } else {
      containerStyle.left = 0;
      containerStyle.bottom = 0;
    }

    return (
      <Modal
        open={true}
        onClose={handleClose}
        title={title}
        width={floatWidth}
        zIndex={zIndex}
        className={`drawer drawer-${drawer}`}
        containerStyle={containerStyle}
      >
        <div
          className="float-content"
          style={{ width: floatWidth, height: terminalHeight }}
          onClick={handleClick}
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
      </Modal>
    );
  }

  // Regular centered float
  const terminalRows = Math.floor(floatState.height / charHeight);
  const floatWidth = floatState.width;
  const floatHeight = floatState.height + 28;
  const left = Math.max(0, (containerWidth - floatWidth) / 2);
  const top = Math.max(0, (containerHeight - floatHeight) / 2);

  return (
    <Modal
      open={true}
      onClose={handleClose}
      title={title}
      width={floatWidth}
      zIndex={zIndex}
      containerStyle={{ left, top }}
    >
      <div
        className="float-content"
        style={{ width: floatWidth, height: floatState.height }}
        onClick={handleClick}
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
    </Modal>
  );
}

/**
 * FloatContainer - Container for float panes
 *
 * Renders whenever float panes exist. Each float gets its own Modal.
 * Clicking backdrop or pressing Esc closes that float.
 * The × button kills that specific float.
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
