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
import { detectWidget, getWidget } from './widgets';
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

/** Extract a display title from widget content lines */
function getWidgetTitle(contentLines: string[]): string | undefined {
  // Check for __TITLE__:name protocol in any content line
  for (const line of contentLines) {
    const titleMatch = line.trim().match(/^__TITLE__:(.+)/);
    if (titleMatch) return titleMatch[1].trim();
  }

  const joined = contentLines.join('').trim();

  // Try HTTP URL — extract filename
  const urlMatch = joined.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    try {
      const pathname = new URL(urlMatch[0]).pathname;
      const filename = pathname.split('/').pop();
      if (filename) return decodeURIComponent(filename);
    } catch { /* ignore */ }
  }

  // Try data URI — show truncated prefix
  const dataMatch = joined.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/]{0,10}/);
  if (dataMatch) return dataMatch[0] + '...';

  return undefined;
}

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

  // Ref to latest handleWheel for the native listener
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  // Widget detection — compute before hooks that depend on it
  const widgetInfo = pane ? detectWidget(pane.content) : null;
  const isWidget = !!widgetInfo;

  // Native wheel listener with { passive: false } so preventDefault() works.
  // Skip for widget panes — they handle their own scrolling.
  useEffect(() => {
    if (isWidget) return;
    const el = wrapperRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => handleWheelRef.current(e as unknown as React.WheelEvent);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [isWidget]);

  // Widget vi-key navigation: capture-phase window listener that fires BEFORE
  // the keyboard actor's bubble-phase window listener.
  const isActiveWidget = isWidget && !!pane?.active && isInActiveWindow;
  const widgetKeyRef = useRef({ send, paneId, isActiveWidget });
  widgetKeyRef.current = { send, paneId, isActiveWidget };

  useEffect(() => {
    if (!isWidget) return;

    const LINE_HEIGHT = 24;

    const handler = (e: KeyboardEvent) => {
      // Only handle when this widget pane is the active pane
      if (!widgetKeyRef.current.isActiveWidget) return;

      const { send: s, paneId: pid } = widgetKeyRef.current;

      // Ctrl+C: send SIGINT to tmux pane (kills widget, restores shell)
      if (e.ctrlKey && e.key === 'c') {
        e.preventDefault();
        e.stopImmediatePropagation();
        s({ type: 'SEND_COMMAND', command: `send-keys -t ${pid} C-c` });
        return;
      }

      const el = wrapperRef.current;
      if (!el) return;
      const scrollEl = el.querySelector('.widget-markdown, .widget-scrollable') as HTMLElement | null;
      if (!scrollEl) return;

      const pageSize = scrollEl.clientHeight;
      let handled = true;

      switch (e.key) {
        case 'j': case 'ArrowDown':
          scrollEl.scrollTop += LINE_HEIGHT;
          break;
        case 'k': case 'ArrowUp':
          scrollEl.scrollTop -= LINE_HEIGHT;
          break;
        case 'd':
          if (e.ctrlKey) scrollEl.scrollTop += pageSize / 2;
          else handled = false;
          break;
        case 'u':
          if (e.ctrlKey) scrollEl.scrollTop -= pageSize / 2;
          else handled = false;
          break;
        case 'g':
          scrollEl.scrollTop = 0;
          break;
        case 'G':
          scrollEl.scrollTop = scrollEl.scrollHeight;
          break;
        case ' ': case 'PageDown':
          scrollEl.scrollTop += pageSize;
          break;
        case 'b': case 'PageUp':
          scrollEl.scrollTop -= pageSize;
          break;
        case 'Home':
          scrollEl.scrollTop = 0;
          break;
        case 'End':
          scrollEl.scrollTop = scrollEl.scrollHeight;
          break;
        default:
          handled = false;
      }

      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    // Capture phase fires before the keyboard actor's bubble-phase listener
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isWidget]);

  // Pane may not exist during transitions
  if (!pane) return null;

  if (widgetInfo) {
    const WidgetComponent = getWidget(widgetInfo.widgetName)!;
    const lastLine = widgetInfo.contentLines.filter(l => l.trim()).pop() || '';
    const widgetTitle = getWidgetTitle(widgetInfo.contentLines);
    const writeStdin = (data: string) => {
      // Use single quotes with escaping for safe literal send-keys
      const escaped = data.replace(/'/g, "'\\''");
      send({ type: 'SEND_COMMAND', command: `send-keys -t ${paneId} -l '${escaped}'` });
    };

    return (
      <div
        ref={wrapperRef}
        className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        role="group"
        aria-label={`Widget pane ${pane.tmuxId}`}
        data-pane-id={pane.tmuxId}
        tabIndex={0}
        onMouseDown={() => {
          send({ type: 'FOCUS_PANE', paneId });
        }}
      >
        <PaneHeader paneId={paneId} titleOverride={widgetTitle} />
        <div className="pane-content" style={{ flex: 1, overflow: 'hidden' }}>
          <WidgetComponent
            paneId={paneId}
            widgetName={widgetInfo.widgetName}
            lines={widgetInfo.contentLines}
            lastLine={lastLine}
            rawContent={pane.content}
            writeStdin={writeStdin}
            width={pane.width}
            height={pane.height}
          />
        </div>
      </div>
    );
  }

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
