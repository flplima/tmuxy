import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Mock AppContext hooks before importing the component under test.
vi.mock('../machines/AppContext', () => ({
  useAppSend: vi.fn(() => vi.fn()),
  useAppActor: vi.fn(() => ({ getSnapshot: () => ({ context: { copyModeStates: {} } }) })),
  usePane: vi.fn(),
  useIsPaneInActiveWindow: vi.fn(() => true),
  useIsSinglePane: vi.fn(() => false),
  useCopyModeState: vi.fn(() => undefined),
  useAppSelector: vi.fn(),
  useAppConfig: vi.fn(() => ({ forwardScrollToParent: false })),
  selectCharSize: vi.fn(),
}));

// Mock heavy children so we can assert purely on what TerminalPane renders.
vi.mock('../components/Terminal', () => ({
  Terminal: () => <div data-testid="terminal-content" />,
}));
vi.mock('../components/ScrollbackTerminal', () => ({
  ScrollbackTerminal: () => <div data-testid="scrollback" />,
}));
vi.mock('../components/PaneHeader', () => ({
  PaneHeader: () => <div className="pane-header" data-testid="pane-header" />,
}));
vi.mock('../components/SelectionContextMenu', () => ({
  SelectionContextMenu: () => <div data-testid="selection-menu" />,
}));
vi.mock('../utils/mobileKeyboard', () => ({
  focusKeyboardInput: vi.fn(),
}));

const noopHandlers = {
  handleMouseDown: vi.fn(),
  handleMouseUp: vi.fn(),
  handleMouseMove: vi.fn(),
  handleMouseLeave: vi.fn(),
  handleWheel: vi.fn(),
  handleDoubleClick: vi.fn(),
  handleTripleClick: vi.fn(),
  selectionStart: undefined,
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
import * as mobileKeyboard from '../utils/mobileKeyboard';

const mockUseAppSend = AppContext.useAppSend as Mock;
const mockUsePane = AppContext.usePane as Mock;
const mockUseAppSelector = AppContext.useAppSelector as Mock;
const mockSelectCharSize = AppContext.selectCharSize as Mock;
const mockFocusKeyboardInput = vi.mocked(mobileKeyboard.focusKeyboardInput);
const mockSend = vi.fn();

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
    mockUseAppSend.mockReturnValue(mockSend);
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

  it('syncs the active pane before moving keyboard focus to the hidden input', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    render(<TerminalPane paneId="%1" />);

    screen.getByRole('group', { name: 'Pane %1: zsh' }).focus();

    expect(mockSend).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%1' });
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%1');
    expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockFocusKeyboardInput.mock.invocationCallOrder[0],
    );
  });

  it('leaves touch-origin focus to the touch handler', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    render(<TerminalPane paneId="%1" />);
    const pane = screen.getByRole('group', { name: 'Pane %1: zsh' });

    fireEvent.pointerDown(pane, { pointerType: 'touch' });
    pane.focus();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockFocusKeyboardInput).not.toHaveBeenCalled();
  });

  it('does not repeat pane selection when focus follows mouse down', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    noopHandlers.handleMouseDown.mockImplementationOnce(() => {
      mockSend({ type: 'FOCUS_PANE', paneId: '%1' });
    });
    render(<TerminalPane paneId="%1" />);
    const pane = screen.getByRole('group', { name: 'Pane %1: zsh' });

    fireEvent.pointerDown(pane, { pointerType: 'mouse' });
    fireEvent.mouseDown(pane);
    pane.focus();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%1');
  });

  it('focuses a header-clicked pane before moving keyboard input to it', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    render(<TerminalPane paneId="%1" />);
    const pane = screen.getByRole('group', { name: 'Pane %1: zsh' });

    fireEvent.pointerDown(screen.getByTestId('pane-header'), { pointerType: 'mouse' });
    fireEvent.mouseDown(screen.getByTestId('pane-header'));
    pane.focus();

    expect(mockSend).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%1' });
    expect(mockFocusKeyboardInput).toHaveBeenCalledWith('%1');
    expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockFocusKeyboardInput.mock.invocationCallOrder[0],
    );
  });

  it('focuses a pane when the initial mouse down is a triple click', () => {
    mockUsePane.mockReturnValue(makePane({ height: 24 }));
    render(<TerminalPane paneId="%1" />);
    const pane = screen.getByRole('group', { name: 'Pane %1: zsh' });

    fireEvent.pointerDown(pane, { pointerType: 'mouse' });
    fireEvent.mouseDown(pane, { detail: 3, button: 0 });
    pane.focus();

    expect(noopHandlers.handleTripleClick).toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith({ type: 'FOCUS_PANE', paneId: '%1' });
    expect(mockSend.mock.invocationCallOrder[0]).toBeLessThan(
      mockFocusKeyboardInput.mock.invocationCallOrder[0],
    );
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
