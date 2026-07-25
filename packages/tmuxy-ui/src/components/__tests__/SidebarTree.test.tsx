import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarTreeRow } from '../sidebarTreeModel';

const mocks = vi.hoisted(() => ({
  context: {
    windows: [
      {
        id: '@0',
        index: 1,
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
        index: 2,
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
      { tmuxId: '%0', windowId: '@0' },
      { tmuxId: '%1', windowId: '@1' },
    ],
    sessions: [
      { sessionName: 'main', windows: [], panes: [] },
      {
        sessionName: 'other',
        windows: [{ id: '@9', index: 0, name: 'foreign' }],
        panes: [
          {
            id: '%9',
            windowId: '@9',
            command: 'bash',
            cwd: '/tmp',
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

vi.mock('../useSidebarTreeKeyboard', () => ({ useSidebarTreeKeyboard: () => undefined }));
vi.mock('../SidebarTreeRows', () => ({
  SidebarTreeRows: ({
    rows,
    collapsed,
    onToggleExpanded,
    onActivate,
  }: {
    rows: SidebarTreeRow[];
    collapsed: ReadonlySet<string>;
    onToggleExpanded: (row: SidebarTreeRow) => void;
    onActivate: (row: SidebarTreeRow) => void;
  }) => (
    <>
      <output data-testid="collapsed-keys">{[...collapsed].join(',')}</output>
      <button type="button" onClick={() => onToggleExpanded(rows[0])}>
        Toggle first row
      </button>
      {rows
        .filter((row) => row.kind === 'pane' || row.kind === 'foreign-pane')
        .map((row) => {
          const id = row.kind === 'pane' ? row.pane.tmuxId : row.paneId;
          return (
            <button key={id} type="button" onClick={() => onActivate(row)}>
              Activate {id}
            </button>
          );
        })}
    </>
  ),
}));

import { SidebarTree } from '../SidebarTree';

describe('SidebarTree', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.send.mockClear();
  });

  it('keeps collapse state local to the mounted tree', () => {
    const { unmount } = render(<SidebarTree focused={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle first row' }));
    expect(screen.getByTestId('collapsed-keys')).toHaveTextContent('s:main');
    expect(localStorage).toHaveLength(0);

    unmount();
    render(<SidebarTree focused={false} />);
    expect(screen.getByTestId('collapsed-keys')).toBeEmptyDOMElement();
  });

  it('selects a live pane window before selecting the pane', () => {
    render(<SidebarTree focused={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate %1' }));

    expect(mocks.send.mock.calls).toEqual([
      [{ type: 'SELECT_TAB', windowId: '@1', windowIndex: 2 }],
      [{ type: 'SEND_TMUX_COMMAND', command: 'select-pane -t %1' }],
    ]);
  });

  it('preserves the exact target while switching a foreign session', () => {
    render(<SidebarTree focused={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate %9' }));

    expect(mocks.send).toHaveBeenCalledWith({
      type: 'SWITCH_SESSION',
      sessionName: 'other',
      windowId: '@9',
      paneId: '%9',
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
