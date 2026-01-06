import { useCallback, useRef, useEffect } from 'react';
import { Terminal } from './components/Terminal';
import { StatusBar } from './components/StatusBar';
import { PaneHeader } from './components/PaneHeader';
import { PaneLayout } from './components/PaneLayout';
import {
  useAppSelector,
  useAppSend,
  useAppState,
  useIsPrefixMode,
  useIsCommandMode,
  selectPreviewPanes,
  selectPanes,
  selectWindows,
  selectIsConnected,
  selectError,
  selectDragTargetNewWindow,
  selectStacks,
} from './machines/AppContext';
import type { TmuxPane, PaneStack } from './machines/types';
import './App.css';

const CHAR_WIDTH = 9.6; // Approximate width of monospace character
const CHAR_HEIGHT = 20; // Approximate height of monospace line
const STATUS_BAR_HEIGHT = 33; // 32px height + 1px border
const PANE_GAP = 8; // Gap between panes and container edges
const HALF_GAP = PANE_GAP / 2; // 4px - container padding and pane margin

// Calculate target dimensions based on window size
// Layout: status bar (33px) + margin-top (8px) + container padding (4px) + pane offset (4px) = edge to pane content
function calculateTargetSize() {
  // Container padding is HALF_GAP on each side, pane offset adds another HALF_GAP
  // But pane offset is visual only - container size should match content area
  const availableWidth = window.innerWidth - HALF_GAP * 2;
  // Height: status bar + margin-top (PANE_GAP) + container padding (HALF_GAP * 2)
  const availableHeight = window.innerHeight - STATUS_BAR_HEIGHT - PANE_GAP - HALF_GAP * 2;

  const cols = Math.floor(availableWidth / CHAR_WIDTH);
  const rows = Math.floor(availableHeight / CHAR_HEIGHT);

  return { cols: Math.max(10, cols), rows: Math.max(5, rows) };
}

function App() {
  const send = useAppSend();

  // Select state from machine
  const panes = useAppSelector(selectPreviewPanes);
  const allPanes = useAppSelector(selectPanes); // For finding panes in a stack
  const windows = useAppSelector(selectWindows);
  const stacks = useAppSelector(selectStacks);
  const connected = useAppSelector(selectIsConnected);
  const error = useAppSelector(selectError);
  const prefixMode = useIsPrefixMode();
  const commandModeActive = useIsCommandMode();
  const isDraggingToNewWindow = useAppSelector(selectDragTargetNewWindow);

  // Helper to find stack for a pane
  const findStackForPane = useCallback(
    (paneId: string): PaneStack | undefined => {
      return Object.values(stacks).find((stack) => stack.paneIds.includes(paneId));
    },
    [stacks]
  );

  // Helper to get all panes in a stack
  const getStackPanes = useCallback(
    (stack: PaneStack): TmuxPane[] => {
      return stack.paneIds
        .map((id) => allPanes.find((p) => p.tmuxId === id))
        .filter((p): p is TmuxPane => p !== undefined);
    },
    [allPanes]
  );

  const isConnecting = useAppState('connecting');

  // Track last sent dimensions to avoid duplicate commands
  const lastSentSize = useRef({ cols: 0, rows: 0 });

  // Set initial char size
  useEffect(() => {
    send({
      type: 'SET_CHAR_SIZE',
      charWidth: CHAR_WIDTH,
      charHeight: CHAR_HEIGHT,
    });
  }, [send]);

  // Update target size based on window dimensions
  const updateTargetSize = useCallback(() => {
    const { cols, rows } = calculateTargetSize();
    // Only send if dimensions actually changed
    if (cols !== lastSentSize.current.cols || rows !== lastSentSize.current.rows) {
      lastSentSize.current = { cols, rows };
      send({ type: 'SET_TARGET_SIZE', cols, rows });
    }
  }, [send]);

  // Set initial size and listen for window resize
  useEffect(() => {
    // Set initial size immediately
    updateTargetSize();

    // Debounced resize handler
    let resizeTimeout: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(updateTargetSize, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
    };
  }, [updateTargetSize]);

  // Re-send size when connection is established
  useEffect(() => {
    if (connected) {
      // Force re-send by resetting lastSentSize
      lastSentSize.current = { cols: 0, rows: 0 };
      updateTargetSize();
    }
  }, [connected, updateTargetSize]);

  // Track mouse state for terminal interactions
  const isDragging = useRef(false);
  const dragPaneId = useRef<string | null>(null);

  const handlePaneScroll = useCallback(
    (e: React.WheelEvent, tmuxId: string) => {
      e.preventDefault();
      const direction = e.deltaY > 0 ? 'Down' : 'Up';
      const scrollAmount = Math.min(Math.abs(Math.round(e.deltaY / 50)), 5) || 1;
      // Enter copy mode and scroll
      send({ type: 'SEND_COMMAND', command: `copy-mode -t ${tmuxId}` });
      for (let i = 0; i < scrollAmount; i++) {
        send({ type: 'SEND_COMMAND', command: `send-keys -t ${tmuxId} ${direction}` });
      }
    },
    [send]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, tmuxId: string) => {
      if (e.button !== 0) return; // Only left click

      // Don't handle clicks on the header (drag is handled separately)
      const target = e.target as HTMLElement;
      if (target.closest('.pane-header')) return;

      // Select this pane
      send({ type: 'FOCUS_PANE', paneId: tmuxId });

      isDragging.current = true;
      dragPaneId.current = tmuxId;
    },
    [send]
  );

  const handleMouseMove = useCallback(
    (_e: React.MouseEvent, tmuxId: string) => {
      if (!isDragging.current || dragPaneId.current !== tmuxId) return;
      // Mouse move events during drag - could be used for selection
    },
    []
  );

  const handleMouseUp = useCallback(
    (_e: React.MouseEvent, _tmuxId: string) => {
      if (!isDragging.current) return;

      isDragging.current = false;
      dragPaneId.current = null;
    },
    []
  );

  if (error) {
    return (
      <div className="error" data-testid="error-display">
        <h2>Error</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (isConnecting || panes.length === 0) {
    return (
      <div className="loading" data-testid="loading-display">
        <p>Connecting to tmux...</p>
      </div>
    );
  }

  const isSinglePane = panes.length === 1;

  return (
    <div className="app-container">
      <StatusBar
        windows={windows}
        commandMode={commandModeActive}
        prefixMode={prefixMode}
        isDraggingToNewWindow={isDraggingToNewWindow}
      />
      <div
        className="pane-container"
        style={{
          position: 'relative',
          padding: HALF_GAP,
          boxSizing: 'border-box',
        }}
      >
        <PaneLayout>
          {(pane: TmuxPane) => (
            <div
              className={`pane-wrapper ${isSinglePane ? 'pane-single' : ''}`}
              style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
              role="group"
              aria-label={`Pane ${pane.tmuxId}: ${pane.command}`}
              aria-roledescription="terminal pane"
              data-pane-id={pane.tmuxId}
              data-pane-command={pane.command}
              tabIndex={0}
              onWheel={(e) => handlePaneScroll(e, pane.tmuxId)}
              onMouseDown={(e) => handleMouseDown(e, pane.tmuxId)}
              onMouseMove={(e) => handleMouseMove(e, pane.tmuxId)}
              onMouseUp={(e) => handleMouseUp(e, pane.tmuxId)}
              onMouseLeave={(e) => handleMouseUp(e, pane.tmuxId)}
            >
              {!isSinglePane && (() => {
                const stack = findStackForPane(pane.tmuxId);
                const stackPanes = stack ? getStackPanes(stack) : undefined;
                return (
                  <PaneHeader
                    tmuxId={pane.tmuxId}
                    paneIndex={pane.id}
                    command={pane.command}
                    isActive={pane.active}
                    stack={stack}
                    stackPanes={stackPanes}
                  />
                );
              })()}
              <div className="pane-content" style={{ flex: 1 }}>
                <Terminal
                  content={pane.content}
                  paneId={pane.id}
                  cursorX={pane.cursorX}
                  cursorY={pane.cursorY}
                  isActive={pane.active}
                  height={pane.height}
                  inMode={pane.inMode}
                  copyCursorX={pane.copyCursorX}
                  copyCursorY={pane.copyCursorY}
                />
              </div>
            </div>
          )}
        </PaneLayout>
      </div>
    </div>
  );
}

export default App;
