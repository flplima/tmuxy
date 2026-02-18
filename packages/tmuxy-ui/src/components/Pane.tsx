/**
 * Pane - Self-contained pane component that gets all data from context
 *
 * Takes only a paneId and fetches everything else via hooks.
 * This eliminates prop drilling and keeps the component self-contained.
 */

import { useRef } from 'react';
import { Terminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import {
  useAppSend,
  useAppSelector,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
  selectCharSize,
} from '../machines/AppContext';
import { usePaneMouse } from '../hooks';

interface PaneProps {
  paneId: string;
}

export function Pane({ paneId }: PaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const contentRef = useRef<HTMLDivElement>(null);

  // Mouse handling with context-aware behavior
  const {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    selectionStart,
  } = usePaneMouse(send, {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    alternateOn: pane?.alternateOn ?? false,
    inMode: pane?.inMode ?? false,
    contentRef,
  });

  // Pane may not exist during transitions
  if (!pane) return null;

  return (
    <div
      className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      role="group"
      aria-label={`Pane ${pane.tmuxId}: ${pane.command}`}
      aria-roledescription="terminal pane"
      data-pane-id={pane.tmuxId}
      data-pane-command={pane.command}
      data-alternate-on={pane.alternateOn}
      data-mouse-any-flag={pane.mouseAnyFlag}
      tabIndex={0}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <PaneHeader paneId={paneId} />
      <div className="pane-content" ref={contentRef} style={{ flex: 1 }}>
        <Terminal
          content={pane.content}
          cursorX={pane.cursorX}
          cursorY={pane.cursorY}
          isActive={pane.active && isInActiveWindow}
          width={pane.width}
          height={pane.height}
          inMode={pane.inMode}
          copyCursorX={pane.copyCursorX}
          copyCursorY={pane.copyCursorY}
          selectionPresent={pane.selectionPresent}
          selectionStart={selectionStart}
          selectionStartX={pane.selectionStartX}
          selectionStartY={pane.selectionStartY}
          selMode={pane.selMode}
        />
      </div>
    </div>
  );
}
