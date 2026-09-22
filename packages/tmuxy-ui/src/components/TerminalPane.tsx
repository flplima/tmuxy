/**
 * TerminalPane - Renders a pane with terminal content.
 *
 * Contains a shared scroll container that wraps both Terminal and
 * ScrollbackTerminal. In normal mode the terminal is pinned to the bottom
 * of a spacer div whose height equals the full scrollback height.
 *
 * Wheel events use the proxy pattern: the pane-wrapper (non-scrollable)
 * intercepts wheel via a native { passive: false } listener, calls
 * preventDefault(), and manually adjusts scrollTop on the scroll container.
 */

import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react';
import { Terminal } from './Terminal';
import { ScrollbackTerminal } from './ScrollbackTerminal';
import {
  cloneNativeSelectionRange,
  readNativeSelection,
  selectWordAtPoint,
} from '../utils/nativeSelection';
import { PaneHeader } from './PaneHeader';
import { SelectionContextMenu } from './SelectionContextMenu';
import {
  useAppSend,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
  useCopyModeState,
  useAppSelector,
  useAppConfig,
  selectCharSize,
  selectKeyboardElsewhere,
} from '../machines/AppContext';
import { usePaneMouse, usePaneTouch } from '../hooks';
import { LogProfiler } from '../utils/renderLog';
import { RowEdges } from './RowEdges';
import { AskOverlay } from './AskOverlay';
import { isCollapsedPane } from '../constants';
import { extractSelectedText } from '../utils/copyMode';

interface TerminalPaneProps {
  paneId: string;
  /**
   * `none` drops the pane header. The pinned dock renders through here so it
   * gets the same wheel/drag/copy-mode layer a tiled pane has, but its title
   * lives in the app header instead.
   */
  chrome?: 'header' | 'none';
  /**
   * Overrides the derived cursor/active state. A dock pane is never tmux's
   * active pane (it lives in another window), so its column tells it when it
   * holds the keyboard.
   */
  isActive?: boolean;
  /**
   * The cell the pane is drawn in, when it is not the pane grid's. The dock
   * runs in the smaller sidebar font, and every pixel-to-cell conversion here
   * (a click, a drag, the wheel, the scrollback height) has to use the cell
   * the user sees: with the grid's larger one, a click in the dock reached
   * tmux cells up and to the left of where it landed.
   */
  cellSize?: { width: number; height: number };
}

export function TerminalPane({ paneId, chrome = 'header', isActive, cellSize }: TerminalPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();
  const gridCell = useAppSelector(selectCharSize);
  const charWidth = cellSize?.width ?? gridCell.charWidth;
  const charHeight = cellSize?.height ?? gridCell.charHeight;
  const keyboardElsewhere = useAppSelector(selectKeyboardElsewhere);
  // The pane holds the keyboard: tmux's active pane in the active window with
  // nothing (float, dock, tree) focused over it — or whatever the dock's column
  // says about its own pane.
  const holdsKeyboard =
    isActive ?? (pane?.active === true && isInActiveWindow && !keyboardElsewhere);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const copyState = useCopyModeState(paneId);
  const { forwardScrollToParent } = useAppConfig();

  // Selection context menu state
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    text: string;
    /** The browser's selection the menu is about; null for copy mode's own. */
    range: Range | null;
  } | null>(null);
  const historySize = pane?.historySize ?? 0;
  const paneHeight = pane?.height ?? 24;
  // In copy mode, use copyState.totalLines for scroll container height so it
  // stays consistent with the copy mode content bounds. The live pane historySize
  // can diverge from copyState.historySize when new output arrives after entering
  // copy mode, causing scroll position / content misalignment.
  const totalHeight = (copyState ? copyState.totalLines : historySize + paneHeight) * charHeight;

  // Track whether we're programmatically setting scroll to suppress onScroll feedback
  const suppressScrollRef = useRef(false);

  // Track the last scrollTop that came from the DOM (user wheel/scroll).
  // When the state machine's scrollTop matches this value, we skip syncing
  // DOM <- state to avoid fighting the native scroll with line-boundary snaps.
  const lastDomScrollTopRef = useRef<number | null>(null);

  // Track previous copy mode scrollTop to skip sync when it hasn't changed
  // (e.g. re-renders from chunk loads that don't alter scrollTop).
  const prevCopyScrollTopRef = useRef<number | null>(null);

  // Scroll indicator (direct DOM manipulation to avoid re-renders)
  const scrollIndicatorRef = useRef<HTMLDivElement | null>(null);
  const scrollIndicatorTimer = useRef<number | null>(null);

  // Context menu timeout refs (cleaned on unmount to prevent stale state updates)
  const flashScrollIndicator = useCallback(() => {
    const el = scrollIndicatorRef.current;
    if (!el) return;
    el.style.opacity = '0.6';
    if (scrollIndicatorTimer.current) clearTimeout(scrollIndicatorTimer.current);
    scrollIndicatorTimer.current = window.setTimeout(() => {
      if (scrollIndicatorRef.current) scrollIndicatorRef.current.style.opacity = '0';
    }, 1200);
  }, []);

  // onScroll: report the container's position while a scrollback view is open
  // (either kind). Opening one is the wheel handler's job, not this one's.
  const handleContainerScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (suppressScrollRef.current) return;

      if (copyState) {
        const el = e.currentTarget;
        const scrollTop = el.scrollTop;
        // Forward scroll position to state machine
        const newScrollTop = Math.floor(scrollTop / charHeight);
        lastDomScrollTopRef.current = newScrollTop;
        send({
          type: 'COPY_MODE_SCROLL',
          paneId,
          scrollTop: newScrollTop,
          nativeSelection: copyState.mode === 'scroll' && readNativeSelection().length > 0,
        });
        flashScrollIndicator();
      }
    },
    [send, paneId, charHeight, copyState, flashScrollIndicator],
  );

  // Keep scroll pinned to bottom in normal mode
  useLayoutEffect(() => {
    if (!copyState && scrollRef.current) {
      suppressScrollRef.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      suppressScrollRef.current = false;
    }
  });

  // Sync scroll position from state -> DOM only for keyboard-initiated changes.
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
      lastDomScrollTopRef.current = null;
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
    handleTripleClick,
    selectionStart,
  } = usePaneMouse(send, {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    alternateOn: pane?.alternateOn ?? false,
    inMode: pane?.inMode ?? false,
    scrollbackMode: copyState?.mode ?? null,
    paneHeight,
    contentRef,
    scrollRef,
    historySize,
    forwardScrollToParent,
  });

  // Touch handling for mobile scroll
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = usePaneTouch({
    paneId,
    charHeight,
    alternateOn: pane?.alternateOn ?? false,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    scrollRef,
    send,
    historySize,
    scrollbackOpen: !!copyState,
    forwardScrollToParent,
  });

  // Ref to latest handleWheel for the native listener
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  // Refs to latest touch handlers for native listeners
  const handleTouchStartRef = useRef(handleTouchStart);
  handleTouchStartRef.current = handleTouchStart;
  const handleTouchMoveRef = useRef(handleTouchMove);
  handleTouchMoveRef.current = handleTouchMove;
  const handleTouchEndRef = useRef(handleTouchEnd);
  handleTouchEndRef.current = handleTouchEnd;

  // Native wheel and touch listeners with { passive: false } so preventDefault() works.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const wheelHandler = (e: WheelEvent) =>
      handleWheelRef.current(e as unknown as React.WheelEvent);
    const touchStartHandler = (e: TouchEvent) => handleTouchStartRef.current(e);
    const touchMoveHandler = (e: TouchEvent) => handleTouchMoveRef.current(e);
    const touchEndHandler = (e: TouchEvent) => handleTouchEndRef.current(e);

    el.addEventListener('wheel', wheelHandler, { passive: false });
    el.addEventListener('touchstart', touchStartHandler, { passive: true });
    // The rest of the gesture is watched on the WINDOW, not on the pane: the
    // finger lands on a terminal row, and opening the scroll view swaps every
    // row out of the document. A touch whose target has been removed keeps
    // being dispatched to that dead node and bubbles nowhere, so a pane-level
    // listener stopped hearing the swipe exactly when it had just begun —
    // the view opened one row above the live screen and went no further.
    // usePaneTouch ignores a move it did not see start on this pane.
    // passive: false so the handlers can call preventDefault(): on a move to
    // stop the page scrolling under the finger, and on a tap to suppress the
    // synthetic mouse events that would steal focus from the mobile
    // keyboard's hidden input.
    window.addEventListener('touchmove', touchMoveHandler, { passive: false });
    window.addEventListener('touchend', touchEndHandler, { passive: false });
    return () => {
      el.removeEventListener('wheel', wheelHandler);
      el.removeEventListener('touchstart', touchStartHandler);
      window.removeEventListener('touchmove', touchMoveHandler);
      window.removeEventListener('touchend', touchEndHandler);
    };
  }, []);

  // Handle right-click context menu for text selection
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;
      if (pane?.mouseAnyFlag) {
        e.preventDefault();
        return;
      }

      e.preventDefault();

      // Copy mode keeps its own cell selection; everywhere else the browser's
      // selection is the real one. Right-clicking with nothing selected picks
      // the word under the pointer first, the way a right-click does in a
      // browser or a native terminal — no mode change, no cursor.
      if (copyState?.mode === 'copy' && copyState.selectionMode) {
        const text = extractSelectedText(copyState);
        if (text) setSelectionMenu({ x: e.clientX, y: e.clientY, text, range: null });
        return;
      }

      let text = readNativeSelection();
      if (!text) {
        selectWordAtPoint(e.clientX, e.clientY);
        text = readNativeSelection();
      }
      // The range is taken now, not when the menu mounts: by then the menu
      // has focus, and WebKit has collapsed the selection it is about.
      if (text) {
        setSelectionMenu({ x: e.clientX, y: e.clientY, text, range: cloneNativeSelectionRange() });
      }
    },
    [pane?.mouseAnyFlag, copyState],
  );

  if (!pane) return null;

  // Collapsed pane (zellij-style stack): tmux has shrunk it to a single row, so
  // there is nothing useful to show. The pane still occupies 2 rows (header +
  // one content row); render the header bar (the "tab") and leave the content
  // row blank. Selecting the pane expands it again (the after-select-pane hook
  // re-lays out the stack).
  const collapsed = isCollapsedPane(pane);

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
      onMouseDown={(e) => {
        if (e.detail >= 3 && e.button === 0) {
          handleTripleClick(e);
          return;
        }
        handleMouseDown(e);
      }}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    >
      <LogProfiler id={`Pane:${paneId}`} />
      {chrome === 'header' && <PaneHeader paneId={paneId} />}
      {!collapsed && selectionMenu && (
        <SelectionContextMenu
          paneId={paneId}
          x={selectionMenu.x}
          y={selectionMenu.y}
          selectedText={selectionMenu.text}
          selectionRange={selectionMenu.range}
          onClose={() => setSelectionMenu(null)}
        />
      )}
      {!collapsed && (
        <div className="pane-content" ref={contentRef} style={{ flex: 1 }}>
          {/* The padding columns, row by row, in the first / last cell's colours.
              Beside the scroll container on purpose: it would clip them. */}
          {!copyState && <RowEdges lines={pane.content} cols={pane.width} />}
          <div
            ref={scrollRef}
            className="pane-scroll-container hide-scrollbar"
            onScroll={handleContainerScroll}
            style={{
              overflowY: copyState ? 'auto' : 'hidden',
              height: '100%',
              position: 'relative',
            }}
          >
            <div style={{ height: copyState ? totalHeight : '100%', position: 'relative' }}>
              {copyState && <ScrollbackTerminal copyState={copyState} isActive={holdsKeyboard} />}
              {/* The live screen stays MOUNTED behind an open scroll view,
                  hidden rather than replaced. Chrome cancels a touch sequence
                  the moment its target leaves the document, and the target of
                  the swipe that opens the view is one of these rows: taking
                  them away killed the gesture at its first row, so the view
                  opened one line above the live screen and the finger had to
                  start again. */}
              {
                <div
                  hidden={!!copyState}
                  style={{ position: 'absolute', bottom: 0, left: 0, right: 0 }}
                >
                  <Terminal
                    content={pane.content}
                    cursorX={pane.cursorX}
                    cursorY={pane.cursorY}
                    // Kept mounted but not the live pane while a view is open:
                    // an active Terminal registers the app's single cursor
                    // anchor, and a hidden one would take it from the copy
                    // cursor the user is actually looking at.
                    isActive={holdsKeyboard && !copyState}
                    width={pane.width}
                    height={pane.height}
                    inMode={pane.inMode}
                    copyCursorX={pane.copyCursorX}
                    copyCursorY={pane.copyCursorY}
                    selectionPresent={pane.selectionPresent}
                    selectionStart={selectionStart}
                    selectionStartX={pane.selectionStartX}
                    selectionStartY={pane.selectionStartY}
                    images={pane.images}
                    paneId={pane.tmuxId}
                    cursorShape={pane.cursorShape}
                    cursorHidden={pane.cursorHidden}
                    selectable={!pane.mouseAnyFlag}
                  />
                </div>
              }
            </div>
          </div>
          {/* The question `tmuxy ask` hung on this pane, over its content.
              Last inside `.pane-content` so it stacks above the terminal, and
              inside it (not over the whole pane) so the header stays legible
              — that is where the pane's title and its close button live. */}
          <AskOverlay paneId={paneId} holdsKeyboard={holdsKeyboard} />

          {/* Scroll position indicator — flashes on scroll in copy mode */}
          {copyState && (
            <div
              ref={scrollIndicatorRef}
              style={{
                position: 'absolute',
                right: 3,
                top: `calc(4px + (100% - 8px) * ${thumbTopPct / 100})`,
                width: 7,
                minHeight: 30,
                height: `calc((100% - 8px) * ${thumbPct / 100})`,
                backgroundColor: 'rgba(255, 255, 255, 0.4)',
                borderRadius: 100,
                opacity: 0,
                transition: 'opacity 300ms ease-out',
                pointerEvents: 'none',
                zIndex: 5,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
