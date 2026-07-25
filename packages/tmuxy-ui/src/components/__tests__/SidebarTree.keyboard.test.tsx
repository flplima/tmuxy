import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: {
    windows: [
      {
        id: '@0',
        index: 8,
        name: 'main',
        active: true,
        windowType: 'tab',
        groupPanes: null,
        floatParent: null,
        floatWidth: null,
        floatHeight: null,
        floatDrawer: null,
        floatBg: null,
        floatNoheader: false,
      },
      {
        id: '@1',
        index: 19,
        name: 'logs',
        active: false,
        windowType: 'tab',
        groupPanes: null,
        floatParent: null,
        floatWidth: null,
        floatHeight: null,
        floatDrawer: null,
        floatBg: null,
        floatNoheader: false,
      },
    ],
    panes: [
      { tmuxId: '%0', windowId: '@0', command: 'bash' },
      { tmuxId: '%1', windowId: '@1', command: 'tail' },
    ],
    sessions: [
      { sessionName: 'main', windows: [], panes: [] },
      {
        sessionName: 'other',
        windows: [
          { id: '@9', index: 42, name: 'editor' },
          { id: '@10', index: 3, name: 'tests' },
        ],
        panes: [
          {
            id: '%9',
            windowId: '@9',
            command: 'nvim',
            cwd: '/tmp/editor',
            active: true,
          },
          {
            id: '%10',
            windowId: '@10',
            command: 'vitest',
            cwd: '/tmp/tests',
            active: true,
          },
        ],
      },
    ],
    repositories: [],
    sessionName: 'main',
    activePaneId: '%0',
    activeWindowId: '@0',
  },
  send: vi.fn(),
}));

vi.mock('../../machines/AppContext', () => ({
  selectVisibleWindows: (context: typeof mocks.context) => context.windows,
  selectPanes: (context: typeof mocks.context) => context.panes,
  selectSessions: (context: typeof mocks.context) => context.sessions,
  selectRepositories: (context: typeof mocks.context) => context.repositories,
  useAppSelector: (selector: (context: typeof mocks.context) => unknown) => selector(mocks.context),
  useAppSelectorShallow: (selector: (context: typeof mocks.context) => unknown) =>
    selector(mocks.context),
  useAppSend: () => mocks.send,
}));

vi.mock('../PaneContextMenu', () => ({ PaneContextMenu: () => null }));
vi.mock('../TabContextMenu', () => ({ TabContextMenu: () => null }));

import { SidebarTree } from '../SidebarTree';

describe('SidebarTree keyboard and visual indices', () => {
  beforeEach(() => {
    mocks.send.mockClear();
  });

  it('uses visual 1-based foreign-window labels but navigates by stable window ID', async () => {
    const user = userEvent.setup();
    render(<SidebarTree focused />);

    const first = screen.getByTestId('tree-foreign-tab-@9');
    const second = screen.getByTestId('tree-foreign-tab-@10');
    expect(first.querySelector('.sidebar-tree-label')).toHaveTextContent('1:editor');
    expect(second.querySelector('.sidebar-tree-label')).toHaveTextContent('2:tests');
    expect(first).not.toHaveTextContent('42:editor');
    expect(second).not.toHaveTextContent('3:tests');

    await user.click(first);
    expect(mocks.send).toHaveBeenCalledWith({
      type: 'SWITCH_SESSION',
      sessionName: 'other',
      windowId: '@9',
    });
  });

  it('moves DOM focus and the sole row tabindex with arrow navigation', async () => {
    const user = userEvent.setup();
    render(<SidebarTree focused />);

    const activePane = screen.getByTestId('tree-pane-%0');
    const nextWindow = screen.getByTestId('tree-tab-@1');
    act(() => activePane.focus());
    expect(activePane).toHaveFocus();
    expect(activePane).toHaveAttribute('tabindex', '0');

    await user.keyboard('{ArrowDown}');

    expect(nextWindow).toHaveFocus();
    expect(nextWindow).toHaveAttribute('tabindex', '0');
    expect(activePane).toHaveAttribute('tabindex', '-1');
    expect(
      screen.getAllByRole('treeitem').filter((element) => element.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
  });

  it('lets Enter and Space activate a focused twisty without activating its row', async () => {
    const user = userEvent.setup();
    render(<SidebarTree focused />);

    const tab = screen.getByTestId('tree-tab-@0');
    const collapse = screen.getByRole('button', { name: 'Collapse t:@0' });
    act(() => collapse.focus());
    expect(collapse).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('tree-pane-%0')).not.toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    expect(mocks.send).not.toHaveBeenCalled();

    const expand = screen.getByRole('button', { name: 'Expand t:@0' });
    act(() => expand.focus());
    await user.keyboard(' ');
    expect(screen.getByTestId('tree-pane-%0')).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-expanded', 'true');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
