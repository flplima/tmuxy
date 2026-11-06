/**
 * A float centred over the tab, or a drawer docked to an edge. The backdrop,
 * Esc and × all close the float, which kills its pane.
 */

import React, { useCallback } from 'react';
import { Modal, MODAL_HEADER_HEIGHT } from './Modal';
import './FloatPane.css';
import { Terminal } from './terminal/Terminal';
import { PaneHeader } from './PaneHeader';
import { AskOverlay } from './AskOverlay';
import { OfferBanner } from './OfferBanner';
import { paneWidgetOf } from './widgets/registry';
import { getTabText } from './paneTabDisplay';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import {
  selectCharSize,
  selectContainerSize,
  selectPhoneLayout,
} from '../machines/selectors/layout';
import { selectVisibleFloats } from '../machines/selectors/panesAndSidebars';
import { LogProfiler } from './renderLog';
import { focusKeyboardInput } from '../infra/dom/mobileKeyboard';
import { CONTAINER_PADDING_BOTTOM, containerPaddingX } from '../constants/layout';
import type { FloatPaneState } from '../machines/types/domain';
import type { TmuxPane } from '../domain/client';

interface FloatPaneProps {
  floatState: FloatPaneState;
  /** Its place among the visible floats, lowest first. */
  stack: number;
}

export function FloatPane({ floatState, stack }: FloatPaneProps) {
  return (
    <LogProfiler id={`FloatPane:${floatState.paneId}`}>
      <FloatPaneInner floatState={floatState} stack={stack} />
    </LogProfiler>
  );
}

function FloatPaneInner({ floatState, stack }: FloatPaneProps) {
  const send = useAppSend();
  const pane = useAppSelector((ctx) =>
    ctx.panes.find((p: TmuxPane) => p.tmuxId === floatState.paneId),
  );
  const focusedFloatPaneId = useAppSelector((ctx) => ctx.focusedFloatPaneId);
  const isFocused = focusedFloatPaneId === floatState.paneId;
  const { charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);
  const paddingX = containerPaddingX(useAppSelector(selectPhoneLayout));

  const handleClose = useCallback(() => {
    send({ type: 'CLOSE_FLOAT', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      send({ type: 'FOCUS_PANE', paneId: floatState.paneId });
      focusKeyboardInput(floatState.paneId);
    },
    [send, floatState.paneId],
  );

  if (!pane) return null;

  const title = getTabText(pane);
  const { drawer, backdrop, hideHeader } = floatState;
  // A drawer's header is the modal's (`.modal-header`, Modal.css); a float's
  // is its pane header, one terminal row (`--pane-header-height`).
  const headerHeight = hideHeader ? 0 : drawer ? MODAL_HEADER_HEIGHT : charHeight;

  // The overlay covers the pane container's padding box while the measured
  // container is its content box, so a drawer adds the padding back to span it.
  if (drawer) {
    const isHorizontal = drawer === 'left' || drawer === 'right';
    const spanWidth = containerWidth + paddingX * 2;
    const spanHeight = containerHeight + CONTAINER_PADDING_BOTTOM;

    const floatWidth = isHorizontal ? floatState.width : spanWidth;
    const floatHeight = isHorizontal ? spanHeight : floatState.height + headerHeight;
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
        stack={stack}
        className={`drawer drawer-${drawer}`}
        containerStyle={containerStyle}
        backdrop={backdrop}
        hideHeader={hideHeader}
        closable
      >
        <div
          className="float-content"
          style={{ width: floatWidth, height: terminalHeight }}
          onClick={handleClick}
        >
          <FloatBody pane={pane} isFocused={isFocused} terminalRows={terminalRows} />
        </div>
      </Modal>
    );
  }

  // Centred on the content box the grid fills; the overlay spans the padding box.
  const terminalRows = Math.floor(floatState.height / charHeight);
  const floatWidth = floatState.width;
  const floatHeight = floatState.height + headerHeight;
  const left = paddingX + Math.max(0, (containerWidth - floatWidth) / 2);
  const top = Math.max(0, (containerHeight - floatHeight) / 2);

  return (
    <Modal
      open={true}
      onClose={handleClose}
      title={title}
      width={floatWidth}
      stack={stack}
      className="float-modal"
      containerStyle={{ left, top, width: floatWidth, height: floatHeight }}
      backdrop={backdrop}
      hideHeader
      closable
    >
      <div
        // A float can be marked too (`prefix m` in it, then `join-pane -s`).
        className={`float-container${pane.marked ? ' pane-marked' : ''}`}
        onClick={handleClick}
        tabIndex={-1}
        data-pane-id={pane.tmuxId}
      >
        {!hideHeader && (
          <PaneHeader paneId={floatState.paneId} isFloat onFloatClose={handleClose} />
        )}
        <div className="float-content" style={{ height: floatState.height }}>
          <FloatBody pane={pane} isFocused={isFocused} terminalRows={terminalRows} />
          {/* `tmuxy pane send -t` can hang a question on a float too. */}
          <AskOverlay paneId={pane.tmuxId} />
          <OfferBanner paneId={pane.tmuxId} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * The widget its pane shows (the session switcher opens as a float), or the
 * terminal. Not `WidgetPane`: that adds its own `PaneHeader` and a
 * `height: 100%` wrapper, which would give the float two headers and a box
 * fighting the float's fixed height.
 */
function FloatBody({
  pane,
  isFocused,
  terminalRows,
}: {
  pane: TmuxPane;
  isFocused: boolean;
  terminalRows: number;
}) {
  const widget = paneWidgetOf(pane);
  if (widget) {
    const WidgetComponent = widget.definition.component;
    return <WidgetComponent paneId={pane.tmuxId} lines={widget.lines} />;
  }
  return (
    <Terminal
      content={pane.content}
      cursorX={pane.cursorX}
      cursorY={pane.cursorY}
      isActive={isFocused}
      height={terminalRows}
      inMode={pane.inMode}
      copyCursorX={pane.copyCursorX}
      copyCursorY={pane.copyCursorY}
      width={pane.width}
      selectionPresent={pane.selectionPresent}
      selectionStartX={pane.selectionStartX}
      selectionStartY={pane.selectionStartY}
      cursorShape={pane.cursorShape}
    />
  );
}

/**
 * The floats of the tab the user is on: a float belongs to the tab it was
 * opened over, so switching tabs takes it off screen.
 */
export function FloatContainer() {
  const visibleFloats = useAppSelector(selectVisibleFloats);

  if (visibleFloats.length === 0) return null;

  return (
    <>
      {visibleFloats.map((floatState, index) => (
        <FloatPane key={floatState.paneId} floatState={floatState} stack={1 + index} />
      ))}
    </>
  );
}
