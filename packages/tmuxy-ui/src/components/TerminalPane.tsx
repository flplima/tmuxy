/**
 * TerminalPane - Renders a pane with terminal content.
 *
 * The pane always renders the live `Terminal` view. tmux owns scrollback and
 * copy mode: scrolling/selection is driven through `send-keys -X` commands
 * (see usePaneMouse / scrollUtils), and the copy cursor + selection are rendered
 * from the coordinates tmux reports in `list-panes`.
 *
 * Wheel/touch events use the proxy pattern: the pane-wrapper (non-scrollable)
 * intercepts them via native { passive: false } listeners, calls preventDefault(),
 * and translates them into tmux scroll commands.
 */

import { useRef, useEffect } from 'react';
import { Terminal } from './Terminal';
import { PaneHeader } from './PaneHeader';
import {
  useAppSend,
  usePane,
  useIsPaneInActiveWindow,
  useIsSinglePane,
  useAppSelector,
  useAppConfig,
  selectCharSize,
} from '../machines/AppContext';
import { usePaneMouse, usePaneTouch } from '../hooks';
import { LogProfiler } from '../utils/renderLog';
import { useScrollShiftAnimation } from '../hooks/useScrollShiftAnimation';
import { selectScrollAnimationEnabled } from '../machines/selectors';
import { isCollapsedPane } from '../constants';

interface TerminalPaneProps {
  paneId: string;
}

// Stable empty content so the scroll-shift hook gets a consistent reference when
// the pane is briefly absent.
const EMPTY_CONTENT: import('../tmux/types').PaneContent = [];

export function TerminalPane({ paneId }: TerminalPaneProps) {
  const send = useAppSend();
  const pane = usePane(paneId);
  const isInActiveWindow = useIsPaneInActiveWindow(paneId);
  const isSinglePane = useIsSinglePane();
  const { charWidth, charHeight } = useAppSelector(selectCharSize);
  const focusedFloatPaneId = useAppSelector((ctx) => ctx.focusedFloatPaneId);
  const contentRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Host element for the scroll-shift animation transform (Phase 7).
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const { forwardScrollToParent } = useAppConfig();

  const historySize = pane?.historySize ?? 0;
  const paneHeight = pane?.height ?? 24;
  const scrollAnimationEnabled = useAppSelector(selectScrollAnimationEnabled);

  // Subtle slide when the pane's content scrolls (copy mode, less/vim, log tails).
  useScrollShiftAnimation({
    content: pane?.content ?? EMPTY_CONTENT,
    enabled: scrollAnimationEnabled,
    lineHeight: charHeight,
    targetRef: terminalHostRef,
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
  } = usePaneMouse(send, {
    paneId,
    charWidth,
    charHeight,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    alternateOn: pane?.alternateOn ?? false,
    inMode: pane?.inMode ?? false,
    paneHeight,
    contentRef,
    historySize,
    forwardScrollToParent,
  });

  // Touch handling for mobile scroll
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = usePaneTouch({
    paneId,
    charHeight,
    alternateOn: pane?.alternateOn ?? false,
    mouseAnyFlag: pane?.mouseAnyFlag ?? false,
    send,
    historySize,
    forwardScrollToParent,
  });

  // Refs to latest handlers for the native listeners
  const handleWheelRef = useRef(handleWheel);
  handleWheelRef.current = handleWheel;
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
    el.addEventListener('touchmove', touchMoveHandler, { passive: false });
    // passive: false so handleTouchEnd can call preventDefault() on taps,
    // which suppresses synthetic mouse events that would steal focus from
    // the mobile keyboard's hidden input.
    el.addEventListener('touchend', touchEndHandler, { passive: false });
    return () => {
      el.removeEventListener('wheel', wheelHandler);
      el.removeEventListener('touchstart', touchStartHandler);
      el.removeEventListener('touchmove', touchMoveHandler);
      el.removeEventListener('touchend', touchEndHandler);
    };
  }, []);

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
    >
      <LogProfiler id={`Pane:${paneId}`} />
      <PaneHeader paneId={paneId} />
      {!collapsed && (
        <div
          className="pane-content"
          ref={contentRef}
          style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
        >
          <div ref={terminalHostRef} className="pane-terminal-host">
            <Terminal
              content={pane.content}
              cursorX={pane.cursorX}
              cursorY={pane.cursorY}
              isActive={pane.active && isInActiveWindow && !focusedFloatPaneId}
              width={pane.width}
              height={pane.height}
              inMode={pane.inMode}
              copyCursorX={pane.copyCursorX}
              copyCursorY={pane.copyCursorY}
              selectionPresent={pane.selectionPresent}
              selectionStartX={pane.selectionStartX}
              selectionStartY={pane.selectionStartY}
              images={pane.images}
              paneId={pane.tmuxId}
              cursorShape={pane.cursorShape}
              cursorHidden={pane.cursorHidden}
            />
          </div>
        </div>
      )}
    </div>
  );
}
