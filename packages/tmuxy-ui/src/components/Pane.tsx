/**
 * Pane - Self-contained pane component that gets all data from context
 *
 * Takes only a paneId and fetches everything else via hooks.
 * This eliminates prop drilling and keeps the component self-contained.
 *
 * Contains a shared scroll container that wraps both Terminal and
 * ScrollbackTerminal. In normal mode the terminal is pinned to the bottom
 * of a spacer div whose height equals the full scrollback height.
 *
 * Wheel events use the proxy pattern: the pane-wrapper (non-scrollable)
 * intercepts wheel via a native { passive: false } listener, calls
 * preventDefault(), and manually adjusts scrollTop on the scroll container.
 */

import { useRef, useCallback, useLayoutEffect, useEffect } from 'react';
import { Terminal } from './Terminal';
import { ScrollbackTerminal } from './ScrollbackTerminal';
import { PaneHeader } from './PaneHeader';
import {
  useAppSend,
  useAppSelector,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
  useCopyModeState,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const copyState = useCopyModeState(paneId);

  const historySize = pane?.historySize ?? 0;
  const paneHeight = pane?.height ?? 24;
  const totalHeight = (historySize + paneHeight) * charHeight;

  // Track whether we're programmatically setting scroll to suppress onScroll feedback
  const suppressScrollRef = useRef(false);

  // Track the last scrollTop that came from the DOM (user wheel/scroll).
  // When the state machine's scrollTop matches this value, we skip syncing
  // DOM ← state to avoid fighting the native scroll with line-boundary snaps.
  const lastDomScrollTopRef = useRef<number | null>(null);

  // onScroll: detect scroll away from bottom → enter copy mode
  const handleContainerScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (suppressScrollRef.current) return;

    const el = e.currentTarget;
    const scrollTop = el.scrollTop;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const atBottom = maxScroll <= 0 || scrollTop >= maxScroll - 1;

    if (copyState) {
      // Already in copy mode — forward scroll to state machine
      const newScrollTop = Math.floor(scrollTop / charHeight);
      lastDomScrollTopRef.current = newScrollTop;
      send({ type: 'COPY_MODE_SCROLL', paneId, scrollTop: newScrollTop });
    } else if (!atBottom && historySize > 0) {
      // Scrolled away from bottom in normal mode — enter copy mode
      const scrollTopLines = Math.floor(scrollTop / charHeight);
      lastDomScrollTopRef.current = scrollTopLines;
      send({ type: 'ENTER_COPY_MODE', paneId, nativeScrollTop: scrollTopLines });
    }
  }, [send, paneId, charHeight, copyState, historySize]);

  // Keep scroll pinned to bottom in normal mode
  useLayoutEffect(() => {
    if (!copyState && scrollRef.current) {
      suppressScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      suppressScrollRef.current = false;
    }
  });

  // Sync scroll position from state → DOM only for keyboard-initiated changes.
  // When the state machine's scrollTop matches lastDomScrollTopRef, the change
  // came from the user's wheel/scroll — don't snap back to line boundaries.
  useLayoutEffect(() => {
    if (copyState && scrollRef.current) {
      if (lastDomScrollTopRef.current !== null && copyState.scrollTop === lastDomScrollTopRef.current) {
        // This state change originated from onScroll — don't fight native scroll
        lastDomScrollTopRef.current = null;
        return;
      }
      lastDomScrollTopRef.current = null;

      // Keyboard-initiated change — sync DOM to state
      const targetScroll = copyState.scrollTop * charHeight;
      if (Math.abs(scrollRef.current.scrollTop - targetScroll) > 1) {
        suppressScrollRef.current = true;
        scrollRef.current.scrollTop = targetScroll;
        suppressScrollRef.current = false;
      }
    }
  });

  // Mouse handling with context-aware behavior
  const {
    handleMouseDown,
    handleMouseUp,
    handleMouseMove,
    handleMouseLeave,
    handleWheel,
    handleDoubleClick,
    selectionStart,
  } = usePaneMouse(send, {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    alternateOn: pane?.alternateOn ?? false,
    inMode: pane?.inMode ?? false,
    copyModeActive: !!copyState,
    paneHeight,
    contentRef,
    scrollRef,
  });

  // Attach native wheel listener with { passive: false } so preventDefault() works.
  // React's onWheel is passive and silently ignores preventDefault().
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => handleWheelRef.current(e as unknown as React.WheelEvent);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // Pane may not exist during transitions
  if (!pane) return null;

  return (
    <div
      ref={wrapperRef}
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
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
    >
      <PaneHeader paneId={paneId} />
      <div className="pane-content" ref={contentRef} style={{ flex: 1 }}>
        <div
          ref={scrollRef}
          className="pane-scroll-container hide-scrollbar"
          onScroll={handleContainerScroll}
          style={{ overflowY: 'auto', height: '100%', position: 'relative' }}
        >
          <div style={{ height: totalHeight, position: 'relative' }}>
            {copyState ? (
              <ScrollbackTerminal copyState={copyState} />
            ) : (
              <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}>
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
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
