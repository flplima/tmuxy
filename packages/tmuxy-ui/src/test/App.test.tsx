import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock the AppContext hooks before importing App
vi.mock('../machines/AppContext', () => ({
  useAppSelector: vi.fn(),
  useAppSend: vi.fn(() => vi.fn()),
  useAppState: vi.fn(),
  selectPreviewPanes: vi.fn(),
  selectError: vi.fn(),
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
import App from '../App';

const mockUseAppSelector = AppContext.useAppSelector as ReturnType<typeof vi.fn>;
const mockUseAppState = AppContext.useAppState as ReturnType<typeof vi.fn>;

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    // Configure mocks for loading state
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return null;
      return undefined;
    });
    mockUseAppState.mockReturnValue(true); // isConnecting = true

    render(<App />);

    expect(screen.getByTestId('loading-display')).toBeInTheDocument();
    expect(screen.getByText('Connecting to tmux...')).toBeInTheDocument();
  });

  it('renders loading state when no panes', () => {
    // Configure mocks for connected but no panes
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return null;
      return undefined;
    });
    mockUseAppState.mockReturnValue(false); // isConnecting = false

    render(<App />);

    // Still shows loading because panes.length === 0
    expect(screen.getByTestId('loading-display')).toBeInTheDocument();
  });

  it('renders error state when error occurs during connection', () => {
    // Configure mocks for error state
    mockUseAppSelector.mockImplementation((selector) => {
      if (selector === AppContext.selectPreviewPanes) return [];
      if (selector === AppContext.selectError) return 'Connection failed';
      return undefined;
    });
    mockUseAppState.mockReturnValue(true); // isConnecting = true

    render(<App />);

    expect(screen.getByTestId('error-display')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });
});
