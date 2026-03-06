/**
 * FloatPane - Centered floating pane or edge-docked drawer
 *
 * Regular float: centered on screen with backdrop
 * Drawer (--left/--right/--top/--bottom): slides from edge, full height or width
 * Backdrop: --bg dim (default), blur, or none
 * Header: hidden with --hide-header
 * Clicking backdrop, pressing Esc, or clicking × all close (kill) the float
 * Green border on all sides when active
 */

import React, { useCallback } from 'react';
import { Modal } from './Modal';
import { Terminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectContainerSize,
  selectCursorBlink,
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
  const focusedFloatPaneId = useAppSelector((ctx) => ctx.focusedFloatPaneId);
  const isFocused = focusedFloatPaneId === floatState.paneId;
  const { charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const cursorBlink = useAppSelector(selectCursorBlink);

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
  const { drawer, backdrop, hideHeader } = floatState;
  const headerHeight = hideHeader ? 0 : 28;

  // Drawer mode: dock to edge with full span on the perpendicular axis
  if (drawer) {
    const isHorizontal = drawer === 'left' || drawer === 'right';

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
        backdrop={backdrop}
        hideHeader={hideHeader}
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
  const floatHeight = floatState.height + headerHeight;
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
      backdrop={backdrop}
      hideHeader={hideHeader}
    >
      <div
        className="float-container"
        style={{ left, top, width: floatWidth, height: floatHeight }}
        onClick={handleClick}
        tabIndex={0}
        data-pane-id={pane.tmuxId}
      >
        {!hideHeader && (
          <PaneHeader paneId={floatState.paneId} isFloat onFloatClose={handleClose} />
        )}
        <div className="float-content" style={{ height: floatState.height }}>
          <Terminal
            content={pane.content}
            cursorX={pane.cursorX}
            cursorY={pane.cursorY}
            isActive={isFocused}
            blink={cursorBlink}
            height={terminalRows}
            inMode={pane.inMode}
            copyCursorX={pane.copyCursorX}
            copyCursorY={pane.copyCursorY}
          />
        </div>
      </div>
    </Modal>
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
