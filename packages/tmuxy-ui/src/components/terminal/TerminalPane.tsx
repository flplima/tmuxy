import { useRef, useState, useCallback } from 'react';
import { Terminal } from './Terminal';
import { ScrollbackTerminal } from './ScrollbackTerminal';
import { cloneNativeSelectionRange, readNativeSelection } from '../../infra/dom/nativeSelection';
import { PaneHeader } from '../PaneHeader';
import { PaneContextMenu } from '../PaneContextMenu';
import { SelectionContextMenu } from '../SelectionContextMenu';
import { TouchSelectionBar } from './TouchSelectionBar';
import {
  useAppSend,
  usePane,
  useIsSinglePane,
  useCopyModeState,
  useAppSelector,
  useAppConfig,
} from '../../machines/appHooks';
import {
  selectCharSize,
  selectPhoneLayout,
  selectPhoneZoom,
} from '../../machines/selectors/layout';
import { selectPaneHoldsKeyboard } from '../../machines/selectors/keyboard';
import { usePaneMouse } from './usePaneMouse';
import { usePaneTouch } from './usePaneTouch';
import { useLatchedContent } from './useLatchedContent';
import { useHeldWhileSelected } from './useHeldWhileSelected';
import { LogProfiler } from '../renderLog';
import { RowEdges } from './RowEdges';
import { AskOverlay } from '../AskOverlay';
import { OfferBanner } from '../OfferBanner';
import { paneSendFor } from '../../domain/paneAsk';
import { isCollapsedPane } from '../../domain/paneGeometry';
import { extractSelectedText } from '../../domain/copyMode';
import { ScrollPositionIndicator } from './TerminalPaneScroll';
import { usePaneNativeListeners, useTerminalPaneScroll } from './terminalPaneScrollHooks';
import type { PaneId } from '../../domain/ids';
import { dot, PANE_HEADER } from '../../infra/dom/terminalDom';

interface TerminalPaneProps {
  paneId: PaneId;
  /** `none` for the pinned dock, whose title lives in the app header. */
  chrome?: 'header' | 'none';
  /**
   * Overrides the derived active state: a dock pane is never tmux's active
   * pane (it lives in another window), so its column says when it holds the
   * keyboard.
   */
  isActive?: boolean;
  /**
   * The cell the pane is drawn in, when it is not the grid's (the dock runs in
   * the smaller sidebar font). Every pixel-to-cell conversion uses it.
   */
  cellSize?: { width: number; height: number };
}

export function TerminalPane({ paneId, chrome = 'header', isActive, cellSize }: TerminalPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  // A capture refresh leaves the grid momentarily empty — a pane-group switch's
  // `swap-pane` does — and drawing that gap blinks the pane.
  const content = useLatchedContent(pane?.content);
  const isSinglePane = useIsSinglePane();
  const gridCell = useAppSelector(selectCharSize);
  const charWidth = cellSize?.width ?? gridCell.charWidth;
  const charHeight = cellSize?.height ?? gridCell.charHeight;
  const paneHoldsKeyboard = useAppSelector((ctx) => selectPaneHoldsKeyboard(ctx, paneId));
  const holdsKeyboard = isActive ?? paneHoldsKeyboard;
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const copyState = useCopyModeState(paneId);
  const { forwardScrollToParent } = useAppConfig();
  // Held still while the browser has a selection on it, so new output cannot
  // slide other text under the highlight.
  const shown = useHeldWhileSelected(
    { content, cursorX: pane?.cursorX ?? 0, cursorY: pane?.cursorY ?? 0 },
    contentRef,
    !copyState,
  );

  const [selectionMenu, setSelectionMenu] = useState<{
    x: number;
    y: number;
    text: string;
    /** The browser's selection the menu is about; null for copy mode's own. */
    range: Range | null;
  } | null>(null);
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number } | null>(null);
  const historySize = pane?.historySize ?? 0;
  const paneHeight = pane?.height ?? 24;
  // The live historySize moves on as output arrives after the view opened;
  // the view's own extent is what the scroll container must match.
  const totalHeight = (copyState ? copyState.totalLines : historySize + paneHeight) * charHeight;

  const { scrollIndicatorRef, handleContainerScroll } = useTerminalPaneScroll({
    paneId,
    charHeight,
    copyState,
    scrollRef,
    send,
  });

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

  // The phone's taps, holds and slides are for a tiled pane. The dock (chrome
  // none) is drawn by the phone too, but a slide on it is not a slide between
  // tabs, and a tap on it brings the keyboard up for it.
  const phoneLayout = useAppSelector(selectPhoneLayout);
  const phoneZoomed = useAppSelector(selectPhoneZoom) !== null;
  const phoneGestures = phoneLayout && chrome === 'header';
  const { handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel } = usePaneTouch({
    paneId,
    charWidth,
    charHeight,
    alternateOn: pane?.alternateOn ?? false,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    scrollRef,
    contentRef,
    send,
    historySize,
    paneHeight,
    scrollbackOpen: !!copyState,
    copyModeActive: copyState?.mode === 'copy',
    phoneLayout: phoneGestures,
    phoneZoomed: phoneGestures && phoneZoomed,
    holdsKeyboard,
    tapRaisesKeyboard: phoneLayout && chrome === 'none',
    forwardScrollToParent,
  });

  usePaneNativeListeners({
    wrapperRef,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  });

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(dot(PANE_HEADER))) return;
      if (pane?.mouseAnyFlag) {
        e.preventDefault();
        return;
      }

      e.preventDefault();

      // The range is taken now, not when the menu mounts: by then the menu has
      // focus, and WebKit has collapsed the selection it is about.
      const copyText =
        copyState?.mode === 'copy' && copyState.selectionMode ? extractSelectedText(copyState) : '';
      const text = copyText || readNativeSelection();
      if (text) {
        const range = copyText ? null : cloneNativeSelectionRange();
        setSelectionMenu({ x: e.clientX, y: e.clientY, text, range });
        return;
      }
      setPaneMenu({ x: e.clientX, y: e.clientY });
    },
    [pane?.mouseAnyFlag, copyState],
  );

  if (!pane) return null;

  // A collapsed pane of a stack (zellij-style) is one row: only its header
  // is drawn, and selecting the pane expands it.
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
      // Not a Tab stop: Tab inside a pane is the terminal's.
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
      {!collapsed && phoneGestures && copyState?.mode === 'copy' && copyState.selectionMode && (
        <TouchSelectionBar paneId={paneId} copyState={copyState} />
      )}
      {!collapsed && paneMenu && (
        <PaneContextMenu
          paneId={paneId}
          x={paneMenu.x}
          y={paneMenu.y}
          onClose={() => setPaneMenu(null)}
          onRename={() => send({ type: 'RENAME_PANE', paneId })}
        />
      )}
      {!collapsed && (
        <div className="pane-content" ref={contentRef} style={{ flex: 1 }}>
          {/* Beside the scroll container, which would clip them. */}
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
              {/* Hidden, not unmounted, behind an open scroll view: a touch
                  is dispatched to the node it started on for its whole life,
                  and once that node is out of the document the event reaches
                  no listener. The swipe that opens the view starts on these rows. */}
              {
                <div hidden={!!copyState} className="pane-live-screen">
                  <Terminal
                    content={shown.content}
                    cursorX={shown.cursorX}
                    cursorY={shown.cursorY}
                    // An active Terminal registers the app's single cursor
                    // anchor: a hidden one would take it from the copy cursor,
                    // and on a pane asking whether to allow a send the cursor
                    // would paint above the blur.
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
          {/* Inside `.pane-content`, not over the whole pane, so the header
              (title, close button) stays legible. */}
          <AskOverlay paneId={paneId} />
          <OfferBanner paneId={paneId} />

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
