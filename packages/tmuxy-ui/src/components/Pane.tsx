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

  // Track previous copy mode scrollTop to skip sync when it hasn't changed
  // (e.g. re-renders from chunk loads that don't alter scrollTop).
  const prevCopyScrollTopRef = useRef<number | null>(null);

  // Scroll indicator (direct DOM manipulation to avoid re-renders)
  const scrollIndicatorRef = useRef<HTMLDivElement | null>(null);
  const scrollIndicatorTimer = useRef<number | null>(null);

  const flashScrollIndicator = useCallback(() => {
    const el = scrollIndicatorRef.current;
    if (!el) return;
    el.style.opacity = '0.5';
    if (scrollIndicatorTimer.current) clearTimeout(scrollIndicatorTimer.current);
    scrollIndicatorTimer.current = window.setTimeout(() => {
      if (scrollIndicatorRef.current) scrollIndicatorRef.current.style.opacity = '0';
    }, 800);
  }, []);

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
      flashScrollIndicator();
    } else if (!atBottom && historySize > 0) {
      // Scrolled away from bottom in normal mode — enter copy mode
      const scrollTopLines = Math.floor(scrollTop / charHeight);
      lastDomScrollTopRef.current = scrollTopLines;
      send({ type: 'ENTER_COPY_MODE', paneId, nativeScrollTop: scrollTopLines });
      flashScrollIndicator();
    }
  }, [send, paneId, charHeight, copyState, historySize, flashScrollIndicator]);

  // Keep scroll pinned to bottom in normal mode
  useLayoutEffect(() => {
    if (!copyState && scrollRef.current) {
      suppressScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      suppressScrollRef.current = false;
    }
  });

  // Sync scroll position from state → DOM only for keyboard-initiated changes.
  // Skip when: (a) scrollTop hasn't changed (re-render from chunk load, etc.)
  //            (b) scrollTop matches lastDomScrollTopRef (change came from wheel)
  useLayoutEffect(() => {
    if (copyState && scrollRef.current) {
      const newScrollTop = copyState.scrollTop;
      const prevScrollTop = prevCopyScrollTopRef.current;
      prevCopyScrollTopRef.current = newScrollTop;

      // scrollTop didn't change — skip (chunk load, selection update, etc.)
      if (newScrollTop === prevScrollTop) return;

      // scrollTop changed but matches DOM-originated value — skip
      if (lastDomScrollTopRef.current !== null && newScrollTop === lastDomScrollTopRef.current) {
        lastDomScrollTopRef.current = null;
        return;
      }
      lastDomScrollTopRef.current = null;

      // Keyboard-initiated change — sync DOM to state
      const targetScroll = newScrollTop * charHeight;
      if (Math.abs(scrollRef.current.scrollTop - targetScroll) > 1) {
        suppressScrollRef.current = true;
        scrollRef.current.scrollTop = targetScroll;
        suppressScrollRef.current = false;
        flashScrollIndicator();
      }
    } else {
      prevCopyScrollTopRef.current = null;
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

  // Scroll indicator geometry (only meaningful in copy mode)
  const totalLines = copyState?.totalLines ?? 0;
  const scrollTop = copyState?.scrollTop ?? 0;
  const thumbPct = totalLines > 0 ? Math.max(5, (paneHeight / totalLines) * 100) : 100;
  const maxScroll = totalLines - paneHeight;
  const thumbTopPct = maxScroll > 0 ? (scrollTop / maxScroll) * (100 - thumbPct) : 0;

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
        {/* Scroll position indicator — flashes on scroll in copy mode */}
        {copyState && (
          <div
            ref={scrollIndicatorRef}
            style={{
              position: 'absolute',
              right: 0,
              top: `calc(3px + (100% - 6px) * ${thumbTopPct / 100})`,
              width: 3,
              height: `calc((100% - 6px) * ${thumbPct / 100})`,
              backgroundColor: 'var(--term-bright-black)',
              opacity: 0,
              transition: 'opacity 150ms ease-out',
              pointerEvents: 'none',
              zIndex: 5,
            }}
          />
        )}
      </div>
    </div>
  );
}
