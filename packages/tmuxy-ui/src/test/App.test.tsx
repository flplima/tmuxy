import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock the AppContext hooks before importing App
vi.mock('../machines/AppContext', () => ({
  useAppSelector: vi.fn(),
  useAppSend: vi.fn(() => vi.fn()),
  useAppState: vi.fn(),
  selectPreviewPanes: vi.fn(),
  selectError: vi.fn(),
  selectContainerSize: vi.fn(),
}));

// Mock child components that depend on machine context
vi.mock('../components/StatusBar', () => ({
  StatusBar: () => <div data-testid="status-bar" />,
}));
vi.mock('../components/TmuxStatusBar', () => ({
  TmuxStatusBar: () => <div data-testid="tmux-status-bar" />,
}));
vi.mock('../components/PaneLayout', () => ({
  PaneLayout: () => <div data-testid="pane-layout" />,
}));
vi.mock('../components/FloatPane', () => ({
  FloatContainer: () => <div data-testid="float-container" />,
}));

// Mock the keyboard handler
vi.mock('../hooks/useKeyboardHandler', () => ({
  useKeyboardHandler: () => {},
}));

// Mock the debug helpers
vi.mock('../utils/debug', () => ({
  initDebugHelpers: vi.fn(),
}));

// Import the mocked module to access mock functions
import * as AppContext from '../machines/AppContext';
import TmuxyApp from '../App';

const mockUseAppSelector = AppContext.useAppSelector as ReturnType<typeof vi.fn>;
const mockUseAppState = AppContext.useAppState as ReturnType<typeof vi.fn>;

describe('TmuxyApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    // Configure mocks for loading state
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return null;
      if (selector === AppContext.selectContainerSize) return { width: 0, height: 0 };
      return undefined;
    });
    mockUseAppState.mockReturnValue(true); // isConnecting = true

    render(<TmuxyApp />);

    expect(screen.getByTestId('loading-display')).toBeInTheDocument();
    expect(screen.getByText('Connecting to tmux...')).toBeInTheDocument();
  });

  it('renders loading state when no panes', () => {
    // Configure mocks for connected but no panes
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return null;
      if (selector === AppContext.selectContainerSize) return { width: 800, height: 600 };
      return undefined;
    });
    mockUseAppState.mockReturnValue(false); // isConnecting = false

    render(<TmuxyApp />);

    // Still shows loading because panes.length === 0
    expect(screen.getByTestId('loading-display')).toBeInTheDocument();
  });

  it('renders loading state when container not yet measured', () => {
    // Connected with panes but container not measured yet
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [{ tmuxId: '%0' }];
      if (selector === AppContext.selectError) return null;
      if (selector === AppContext.selectContainerSize) return { width: 0, height: 0 };
      return undefined;
    });
    mockUseAppState.mockReturnValue(false); // isConnecting = false

    render(<TmuxyApp />);

    // Shows loading because container width is 0
    expect(screen.getByTestId('loading-display')).toBeInTheDocument();
  });

  it('renders error state when error occurs during connection', () => {
    // Configure mocks for error state
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return 'Connection failed';
      if (selector === AppContext.selectContainerSize) return { width: 0, height: 0 };
      return undefined;
    });
    mockUseAppState.mockReturnValue(true); // isConnecting = true

    render(<TmuxyApp />);

    expect(screen.getByTestId('error-display')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('always renders app-container with StatusBar and TmuxStatusBar', () => {
    // Even during loading, the layout shell is rendered
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return null;
      if (selector === AppContext.selectContainerSize) return { width: 0, height: 0 };
      return undefined;
    });
    mockUseAppState.mockReturnValue(true); // isConnecting = true

    render(<TmuxyApp />);

    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tmux-status-bar')).toBeInTheDocument();
  });
});
