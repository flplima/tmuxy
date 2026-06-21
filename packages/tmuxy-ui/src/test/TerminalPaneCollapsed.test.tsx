import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock AppContext hooks before importing the component under test.
vi.mock('../machines/AppContext', () => ({
  useAppSend: vi.fn(() => vi.fn()),
  usePane: vi.fn(),
  useIsPaneInActiveWindow: vi.fn(() => true),
  useIsSinglePane: vi.fn(() => false),
  useAppSelector: vi.fn(),
  useAppConfig: vi.fn(() => ({ forwardScrollToParent: false })),
  selectCharSize: vi.fn(),
}));

// Mock heavy children so we can assert purely on what TerminalPane renders.
vi.mock('../components/Terminal', () => ({
  Terminal: () => <div data-testid="terminal-content" />,
}));
vi.mock('../components/PaneHeader', () => ({
  PaneHeader: () => <div data-testid="pane-header" />,
}));

const noopHandlers = {
  handleMouseDown: vi.fn(),
  handleMouseUp: vi.fn(),
  handleMouseMove: vi.fn(),
  handleMouseLeave: vi.fn(),
  handleWheel: vi.fn(),
  handleDoubleClick: vi.fn(),
  handleTripleClick: vi.fn(),
};
vi.mock('../hooks', () => ({
  usePaneMouse: vi.fn(() => noopHandlers),
  usePaneTouch: vi.fn(() => ({
    handleTouchStart: vi.fn(),
    handleTouchMove: vi.fn(),
    handleTouchEnd: vi.fn(),
  })),
}));

import * as AppContext from '../machines/AppContext';
import { TerminalPane } from '../components/TerminalPane';

const mockUsePane = AppContext.usePane as ReturnType<typeof vi.fn>;
const mockUseAppSelector = AppContext.useAppSelector as ReturnType<typeof vi.fn>;
const mockSelectCharSize = AppContext.selectCharSize as ReturnType<typeof vi.fn>;

function makePane(overrides: Record<string, unknown>) {
  return {
    id: 1,
    tmuxId: '%1',
    windowId: '@0',
    content: { lines: [] },
    cursorX: 0,
    cursorY: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 1,
    active: true,
    command: 'zsh',
    title: '',
    borderTitle: '',
    inMode: false,
    copyCursorX: 0,
    copyCursorY: 0,
    alternateOn: false,
    mouseAnyFlag: false,
    paused: false,
    historySize: 0,
    selectionPresent: false,
    selectionStartX: 0,
    selectionStartY: 0,
    cursorShape: 2,
    cursorHidden: false,
    ...overrides,
  };
}

describe('TerminalPane — collapsed (stacked) pane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const ctx = { charWidth: 9.6, charHeight: 21, focusedFloatPaneId: null };
    mockSelectCharSize.mockImplementation(() => ({ charWidth: 9.6, charHeight: 21 }));
    mockUseAppSelector.mockImplementation((sel: (c: typeof ctx) => unknown) => sel(ctx));
  });

  it('renders terminal content for a normal-height pane', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    render(<TerminalPane paneId="%1" />);
    expect(screen.getByTestId('pane-header')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-content')).toBeInTheDocument();
  });

  it('hides terminal content for a collapsed pane (height === 1), keeping the header', () => {
    mockUsePane.mockReturnValue(makePane({ height: 1 }));
    render(<TerminalPane paneId="%1" />);
    // Header (the "tab") still shows so the pane can be selected to expand it.
    expect(screen.getByTestId('pane-header')).toBeInTheDocument();
    // Content is not rendered — a 1-row pane has nothing useful to show.
    expect(screen.queryByTestId('terminal-content')).not.toBeInTheDocument();
  });
});
