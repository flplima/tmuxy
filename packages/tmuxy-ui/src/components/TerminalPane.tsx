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

import { useRef, useState, useCallback } from 'react';
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
} from '../machines/appHooks';
import { selectCharSize } from '../machines/selectors/layout';
import { selectKeyboardElsewhere } from '../machines/selectors/ui';
import { usePaneMouse } from '../hooks/usePaneMouse';
import { usePaneTouch } from '../hooks/usePaneTouch';
import { useLatchedContent } from '../hooks/useLatchedContent';
import { useHeldWhileSelected } from '../hooks/useHeldWhileSelected';
import { LogProfiler } from '../utils/renderLog';
import { RowEdges } from './RowEdges';
import { AskOverlay } from './AskOverlay';
import { OfferBanner } from './OfferBanner';
import { paneSendFor } from '../utils/paneAsk';
import { isCollapsedPane } from '../constants/layout';
import { extractSelectedText } from '../utils/copyMode';
import { ScrollPositionIndicator } from './TerminalPaneScroll';
import { usePaneNativeListeners, useTerminalPaneScroll } from './terminalPaneScrollHooks';
import type { PaneId } from '../domain/ids';

interface TerminalPaneProps {
  paneId: PaneId;
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
  // The grid to draw: the pane's own, or the last real one while a capture
  // refresh leaves it momentarily empty. A pane-group switch does `swap-pane`,
  // which is exactly that gap — and drawing it blinked the pane.
  const content = useLatchedContent(pane?.content);
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
  // The screen the live grid draws: held still while the browser has a
  // selection on it, so new output cannot slide other text under the
  // highlight. The scroll view holds its own rows by absolute line.
  const shown = useHeldWhileSelected(
    { content, cursorX: pane?.cursorX ?? 0, cursorY: pane?.cursorY ?? 0 },
    contentRef,
    !copyState,
  );

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

  const { scrollIndicatorRef, handleContainerScroll } = useTerminalPaneScroll({
    paneId,
    charHeight,
    copyState,
    scrollRef,
    send,
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

  usePaneNativeListeners({
    wrapperRef,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  });

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
      // Focusable for the pointer, which hands the focus on to the keyboard
      // input; not a Tab stop, since Tab inside a pane is the terminal's.
      tabIndex={-1}
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
          {!copyState && <RowEdges lines={content} cols={pane.width} />}
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
              {copyState && (
                <ScrollbackTerminal
                  copyState={copyState}
                  isActive={holdsKeyboard}
                  images={pane.images}
                  paneId={pane.tmuxId}
                />
              )}
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
                    content={shown.content}
                    cursorX={shown.cursorX}
                    cursorY={shown.cursorY}
                    // Kept mounted but not the live pane while a view is open:
                    // an active Terminal registers the app's single cursor
                    // anchor, and a hidden one would take it from the copy
                    // cursor the user is actually looking at. A pane asking
                    // whether to allow a send draws none either: the cursor
                    // paints above every pane and would sit on the blur.
                    isActive={holdsKeyboard && !copyState && !paneSendFor(pane)}
                    width={pane.width}
                    height={pane.height}
                    inMode={pane.inMode}
                    copyCursorX={pane.copyCursorX}
                    copyCursorY={pane.copyCursorY}
                    selectionPresent={pane.selectionPresent}
                    selectionStart={selectionStart}
                    selectionStartX={pane.selectionStartX}
                    selectionStartY={pane.selectionStartY}
                    images={copyState ? undefined : pane.images}
                    paneId={pane.tmuxId}
                    cursorShape={pane.cursorShape}
                    cursorHidden={pane.cursorHidden}
                    selectable={!pane.mouseAnyFlag}
                  />
                </div>
              }
            </div>
          </div>
          {/* The question `tmuxy pane send -t` hung on this pane, over its content.
              Last inside `.pane-content` so it stacks above the terminal, and
              inside it (not over the whole pane) so the header stays legible
              — that is where the pane's title and its close button live. */}
          <AskOverlay paneId={paneId} />
          <OfferBanner paneId={paneId} />

          {/* Scroll position indicator — flashes on scroll in copy mode */}
          {copyState && (
            <ScrollPositionIndicator
              indicatorRef={scrollIndicatorRef}
              copyState={copyState}
              paneHeight={paneHeight}
            />
          )}
        </div>
      )}
    </div>
  );
}
