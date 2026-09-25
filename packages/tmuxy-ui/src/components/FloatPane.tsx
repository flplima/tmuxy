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

import React, { useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { Terminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import { AskOverlay } from './AskOverlay';
import { useFramedPaneFocus } from '../hooks';
import { getWidget } from './widgets';
import { usePaneWidgetInfo, type PaneWidgetInfo } from './widgets/usePaneWidgetInfo';
import { getTabText } from './paneTabDisplay';
import {
  useAppSend,
  useAppSelector,
  selectCharSize,
  selectContainerSize,
  selectVisibleFloats,
  useReadOnly,
} from '../machines/AppContext';
import { LogProfiler } from '../utils/renderLog';
import { focusKeyboardInput } from '../utils/mobileKeyboard';
import type { FloatPaneState } from '../machines/types';
import type { TmuxPane } from '../machines/types';

interface FloatPaneProps {
  floatState: FloatPaneState;
  zIndex?: number;
}

export function FloatPane({ floatState, zIndex = 1001 }: FloatPaneProps) {
  return (
    <LogProfiler id={`FloatPane:${floatState.paneId}`}>
      <FloatPaneInner floatState={floatState} zIndex={zIndex} />
    </LogProfiler>
  );
}

function FloatPaneInner({ floatState, zIndex = 1001 }: FloatPaneProps) {
  const send = useAppSend();
  const pane = useAppSelector((ctx) =>
    ctx.panes.find((p: TmuxPane) => p.tmuxId === floatState.paneId),
  );
  const focusedFloatPaneId = useAppSelector((ctx) => ctx.focusedFloatPaneId);
  const isFocused = focusedFloatPaneId === floatState.paneId;
  // A float can hold a widget too — the session switcher opens as one. Same
  // classification the tiled panes use, so a marker never renders as text.
  const widgetInfo = usePaneWidgetInfo(pane?.content, pane?.paneWidget);
  const { charHeight } = useAppSelector(selectCharSize);
  const { width: containerWidth, height: containerHeight } = useAppSelector(selectContainerSize);

  // A float is a tmux window: a viewer cannot close one, only look at it.
  const readOnly = useReadOnly();
  const handleClose = useCallback(() => {
    send({ type: 'CLOSE_FLOAT', paneId: floatState.paneId });
  }, [send, floatState.paneId]);

  // A widget in a float writes to its pane the same way one in a tiled pane
  // does (see WidgetPane) — the browser widget's forms need it, and a widget
  // should not care which surface is hosting it.
  const writeStdin = useCallback(
    (data: string) => {
      send({ type: 'WRITE_TO_PANE', paneId: floatState.paneId, data });
    },
    [send, floatState.paneId],
  );

  // A float showing the browser widget has the same hole a tiled one does:
  // a click inside the frame never reaches `handleClick`, so the float would
  // not take focus. See `useFramedPaneFocus`.
  const containerRef = useRef<HTMLDivElement>(null);
  useFramedPaneFocus(floatState.paneId, containerRef);

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
        closeOnEsc={false}
        closable={!readOnly}
      >
        <div
          className="float-content"
          style={{ width: floatWidth, height: terminalHeight }}
          onClick={handleClick}
        >
          <FloatBody
            pane={pane}
            widgetInfo={widgetInfo}
            isFocused={isFocused}
            terminalRows={terminalRows}
            onWriteStdin={writeStdin}
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
      className="float-modal"
      containerStyle={{ left, top, width: floatWidth, height: floatHeight }}
      backdrop={backdrop}
      hideHeader
      closeOnEsc={false}
      closable={!readOnly}
    >
      <div
        ref={containerRef}
        // A float can be marked too (`prefix m` in it, then `join-pane -s`
        // from elsewhere), and it wears the mark the same way a tiled pane
        // does: the badge in its header, the accent wash over its content.
        className={`float-container${pane.marked ? ' pane-marked' : ''}`}
        onClick={handleClick}
        tabIndex={0}
        data-pane-id={pane.tmuxId}
      >
        {!hideHeader && (
          <PaneHeader paneId={floatState.paneId} isFloat onFloatClose={handleClose} />
        )}
        <div className="float-content" style={{ height: floatState.height }}>
          <FloatBody
            pane={pane}
            widgetInfo={widgetInfo}
            isFocused={isFocused}
            terminalRows={terminalRows}
            onWriteStdin={writeStdin}
          />
          {/* A float is a pane like any other, so `tmuxy ask` can hang a
              question on it — and it is drawn over the tab, so leaving it out
              would put a question on screen with no way to answer it. */}
          <AskOverlay paneId={pane.tmuxId} holdsKeyboard={isFocused} />
        </div>
      </div>
    </Modal>
  );
}

/**
 * What a float draws inside its content box: the widget its pane declared, or
 * the terminal.
 *
 * Deliberately NOT `WidgetPane`. That wraps the widget in its own
 * `pane-wrapper` at `height: 100%` with its own `PaneHeader` — but a float
 * already draws a header and sizes its body itself, so reusing it would give
 * the float two headers and a box fighting the float's fixed height.
 */
function FloatBody({
  pane,
  widgetInfo,
  isFocused,
  terminalRows,
  onWriteStdin,
}: {
  pane: TmuxPane;
  widgetInfo: PaneWidgetInfo;
  isFocused: boolean;
  terminalRows: number;
  onWriteStdin: (data: string) => void;
}) {
  const definition = widgetInfo ? getWidget(widgetInfo.widgetName) : undefined;
  if (widgetInfo && definition) {
    const WidgetComponent = definition.component;
    return (
      <WidgetComponent
        paneId={pane.tmuxId}
        widgetName={widgetInfo.widgetName}
        lines={widgetInfo.contentLines}
        lastLine={widgetInfo.contentLines.filter((l) => l.trim()).pop() || ''}
        rawContent={pane.content}
        writeStdin={onWriteStdin}
        width={pane.width}
        height={pane.height}
      />
    );
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
 * FloatContainer - the floats of the tab the user is on.
 *
 * Renders inline inside .pane-container, so each float's backdrop dims that
 * tab's content and nothing else. A float belongs to the tab it was opened over
 * (`selectVisibleFloats`), so switching tabs takes it off screen and coming back
 * brings it up again.
 */
export function FloatContainer() {
  const visibleFloats = useAppSelector(selectVisibleFloats);

  if (visibleFloats.length === 0) return null;

  return (
    <>
      {visibleFloats.map((floatState, index) => (
        <FloatPane key={floatState.paneId} floatState={floatState} zIndex={1001 + index} />
      ))}
    </>
  );
}
