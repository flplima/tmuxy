import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock the AppContext hooks before importing App
vi.mock('../machines/AppContext', () => ({
  useAppSelector: vi.fn(),
  useAppSend: vi.fn(() => vi.fn()),
  useAppState: vi.fn(),
  useAppConfig: vi.fn(() => ({})),
  selectPreviewPanes: vi.fn(),
  selectError: vi.fn(),
  selectFatalError: vi.fn(),
  selectLog: vi.fn(),
  selectContainerSize: vi.fn(),
  selectCharSize: vi.fn(),
  selectCellMetrics: vi.fn(),
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
vi.mock('../components/TabOverview', () => ({
  TabOverview: () => null,
}));
vi.mock('../components/Sidebar', () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));
vi.mock('../components/SidebarBackdrop', () => ({
  SidebarBackdrop: () => null,
}));
vi.mock('../components/RightSidebar', () => ({
  RightSidebar: () => null,
}));

// Import the mocked module to access mock functions
import * as AppContext from '../machines/AppContext';
import App from '../App';

const mockUseAppSelector = AppContext.useAppSelector as ReturnType<typeof vi.fn>;
const mockUseAppState = AppContext.useAppState as ReturnType<typeof vi.fn>;

interface Scene {
  panes?: unknown[];
  error?: string | null;
  fatalError?: string | null;
  container?: { width: number; height: number };
  state?: 'connecting' | 'reconnecting' | 'idle';
}

/** Put the mocked machine in one connection scene. */
function scene({
  panes = [],
  error = null,
  fatalError = null,
  container = { width: 0, height: 0 },
  state = 'connecting',
}: Scene) {
  mockUseAppSelector.mockImplementation((selector) => {
    if (selector === AppContext.selectPreviewPanes) return panes;
    if (selector === AppContext.selectError) return error;
    if (selector === AppContext.selectFatalError) return fatalError;
    if (selector === AppContext.selectLog)
      return [{ timestamp: 0, kind: 'command', message: 'get_initial_state' }];
    if (selector === AppContext.selectContainerSize) return container;
    if (selector === AppContext.selectCharSize) return { charWidth: 8, charHeight: 16 };
    if (selector === AppContext.selectCellMetrics) return { cellWidth: 8, cellGap: 0 };
    if (typeof selector === 'function') return selector({ tabOverviewOpen: false });
    return undefined;
  });
  mockUseAppState.mockImplementation((value: string) => value === state);
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first load: pane placeholder, spinner and "Connecting…" — no log', () => {
    scene({ state: 'connecting' });
    render(<App />);

    const overlay = screen.getByTestId('loading-display');
    expect(overlay).toHaveAttribute('data-mode', 'connecting');
    expect(overlay.querySelector('.connection-placeholder')).not.toBeNull();
    expect(overlay.querySelector('.connection-spinner')).not.toBeNull();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByTestId('status-log')).toBeNull();
    expect(screen.queryByText(/Details/)).toBeNull();
    expect(screen.queryByTestId('pane-layout')).toBeNull();
  });

  it('connected but no panes yet, or container unmeasured: still connecting', () => {
    scene({ state: 'idle', container: { width: 800, height: 600 } });
    const { unmount } = render(<App />);
    expect(screen.getByTestId('loading-display')).toHaveAttribute('data-mode', 'connecting');
    unmount();

    scene({ state: 'idle', panes: [{ tmuxId: '%0' }] });
    render(<App />);
    expect(screen.getByTestId('loading-display')).toHaveAttribute('data-mode', 'connecting');
  });

  it('a transient error while connecting is one line under the spinner, still no log', () => {
    scene({ state: 'connecting', error: 'Connection failed' });
    render(<App />);

    expect(screen.getByTestId('loading-display')).toHaveAttribute('data-mode', 'connecting');
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.queryByTestId('status-log')).toBeNull();
  });

  it('once ready the layout shows and no overlay covers it', () => {
    scene({ state: 'idle', panes: [{ tmuxId: '%0' }], container: { width: 800, height: 600 } });
    render(<App />);

    expect(screen.getByTestId('pane-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-display')).toBeNull();
    expect(screen.queryByTestId('fatal-display')).toBeNull();
  });

  it('a dropped channel keeps the layout mounted under a blurred "Connecting…" overlay', () => {
    scene({
      state: 'reconnecting',
      panes: [{ tmuxId: '%0' }],
      container: { width: 800, height: 600 },
    });
    render(<App />);

    expect(screen.getByTestId('pane-layout')).toBeInTheDocument();
    const overlay = screen.getByTestId('loading-display');
    expect(overlay).toHaveAttribute('data-mode', 'reconnecting');
    expect(overlay.classList.contains('connection-overlay-over-layout')).toBe(true);
    // The last snapshot is the backdrop: no placeholder frame on top of it.
    expect(overlay.querySelector('.connection-placeholder')).toBeNull();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('fatal: the reason, a Retry button and the log behind a collapsed Details', () => {
    scene({
      state: 'idle',
      panes: [{ tmuxId: '%0' }],
      container: { width: 800, height: 600 },
      fatalError: 'tmux server exited',
    });
    render(<App />);

    const overlay = screen.getByTestId('fatal-display');
    expect(overlay).toHaveAttribute('data-mode', 'fatal');
    expect(screen.getByText('tmux server exited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    const details = overlay.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId('status-log')).toHaveTextContent('get_initial_state');
    // The dead layout stays as the blurred backdrop for a Retry to come back to.
    expect(screen.getByTestId('pane-layout')).toBeInTheDocument();
  });

  it('always renders app-container with StatusBar and TmuxStatusBar', () => {
    scene({ state: 'connecting' });
    render(<App />);

    expect(screen.getByTestId('status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('tmux-status-bar')).toBeInTheDocument();
  });
});
