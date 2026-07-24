import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: {
    sidebarOpen: true,
    sidebarFocused: false,
    charSize: { charWidth: 8, charHeight: 16 },
    serverList: [],
    currentServerId: 'local',
    sessions: [
      {
        sessionName: 'main',
        windows: [{ id: '@0', index: 0, name: 'main' }],
        panes: [
          {
            id: '%0',
            windowId: '@0',
            command: 'bash',
            cwd: '/code/app/src',
            active: true,
          },
        ],
      },
    ],
    repositories: [
      {
        id: 'app',
        name: 'app',
        root: '/code/app',
        worktrees: [
          {
            path: '/code/app',
            branch: 'main',
            head: 'abc123',
            isMain: true,
            locked: false,
            prunable: false,
            detached: false,
            bare: false,
          },
        ],
      },
    ],
    sessionName: 'main',
  },
  send: vi.fn(),
}));

vi.mock('../../machines/AppContext', () => ({
  selectCharSize: (context: typeof mocks.context) => context.charSize,
  selectServerList: (context: typeof mocks.context) => context.serverList,
  selectCurrentServerId: (context: typeof mocks.context) => context.currentServerId,
  selectSessions: (context: typeof mocks.context) => context.sessions,
  selectRepositories: (context: typeof mocks.context) => context.repositories,
  useAppSelector: (selector: (context: typeof mocks.context) => unknown) => selector(mocks.context),
  useAppSelectorShallow: (selector: (context: typeof mocks.context) => unknown) =>
    selector(mocks.context),
  useAppSend: () => mocks.send,
}));

vi.mock('../../tmux/adapters', () => ({ isTauri: () => false }));
vi.mock('../../utils/renderLog', () => ({
  LogProfiler: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../SidebarTree', () => ({
  SidebarTree: () => <div data-testid="mock-sidebar-tree" />,
}));

import { Sidebar } from '../Sidebar';

describe('Sidebar', () => {
  beforeEach(() => {
    mocks.context.sidebarOpen = true;
    mocks.send.mockClear();
  });

  it('keeps its fixed character-column width with no resize affordance', () => {
    render(<Sidebar />);

    const sidebar = screen.getByTestId('sidebar-content');
    expect(sidebar).toHaveStyle({ width: '240px' });
    expect(sidebar).toHaveAttribute('data-sidebar-width', '240');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('decorates the implicit single-session header with its Git context', () => {
    render(<Sidebar />);

    expect(screen.getByText('tree')).toBeInTheDocument();
    expect(screen.getByText('app / main (main)')).toBeInTheDocument();
  });

  it('does not mount the expensive tree while closed', () => {
    mocks.context.sidebarOpen = false;
    render(<Sidebar />);

    expect(screen.queryByTestId('mock-sidebar-tree')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-content')).not.toBeInTheDocument();
  });
});
