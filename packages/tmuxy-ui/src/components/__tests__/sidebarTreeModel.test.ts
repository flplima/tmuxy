import { describe, expect, it } from 'vitest';
import type { TmuxPane, TmuxWindow } from '../../machines/types';
import type { GitRepository, SessionTreeNode } from '../../workspaces/model';
import {
  createSidebarTreeIndex,
  flattenSidebarTree,
  indexLivePanesByWindow,
  rowKey,
  worktreeLabel,
} from '../sidebarTreeModel';

const window: TmuxWindow = {
  id: '@0',
  index: 0,
  name: 'editor',
  active: true,
  windowType: 'tab',
  groupPanes: null,
  floatParent: null,
  floatWidth: null,
  floatHeight: null,
  floatDrawer: null,
  floatBg: null,
  floatNoheader: false,
};

const pane = { tmuxId: '%0', windowId: '@0' } as TmuxPane;

const repositories: GitRepository[] = [
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
      {
        path: '/code/app-worktree',
        branch: 'feature',
        head: 'def456',
        isMain: false,
        locked: false,
        prunable: false,
        detached: false,
        bare: false,
      },
    ],
  },
];

const session = (
  sessionName: string,
  paneId: string,
  windowId: string,
  cwd: string,
): SessionTreeNode => ({
  sessionName,
  windows: [{ id: windowId, index: 0, name: 'editor' }],
  panes: [{ id: paneId, windowId, command: 'nvim', cwd, active: true }],
});

describe('sidebarTreeModel', () => {
  it('labels branch, detached, and bare worktrees without sentinel collisions', () => {
    const base = {
      path: '/code/app',
      head: 'abc123456789',
      isMain: false,
      locked: false,
      prunable: false,
    };

    expect(worktreeLabel({ ...base, branch: 'detached', detached: false, bare: false })).toBe(
      'detached',
    );
    expect(worktreeLabel({ ...base, detached: true, bare: false })).toBe('detached @ abc12345');
    expect(worktreeLabel({ ...base, detached: false, bare: true })).toBe('bare');
  });

  it('keeps a single session implicit and honors collapsed windows', () => {
    const sessions = [session('main', '%0', '@0', '/code/app/src')];
    const index = createSidebarTreeIndex(sessions, repositories);
    const livePanesByWindow = indexLivePanesByWindow([pane]);
    const expanded = flattenSidebarTree({
      index,
      windows: [window],
      sessions,
      sessionName: 'main',
      collapsed: new Set(),
      livePanesByWindow,
    });

    expect(expanded.map(rowKey)).toEqual(['t:@0', 'p:%0']);
    expect(expanded.map((row) => row.depth)).toEqual([0, 1]);
    expect(expanded[0]).toMatchObject({
      kind: 'tab',
      displayIndex: 1,
      gitContext: { kind: 'single', context: { worktree: { branch: 'main' } } },
      showGitBadge: false,
    });

    const collapsed = flattenSidebarTree({
      index,
      windows: [window],
      sessions,
      sessionName: 'main',
      collapsed: new Set(['t:@0']),
      livePanesByWindow,
    });
    expect(collapsed.map(rowKey)).toEqual(['t:@0']);
  });

  it('keeps live windows visible before workspace discovery arrives', () => {
    const index = createSidebarTreeIndex([], []);
    const rows = flattenSidebarTree({
      index,
      windows: [window],
      sessions: [],
      sessionName: 'main',
      collapsed: new Set(),
      livePanesByWindow: indexLivePanesByWindow([pane]),
    });
    expect(rows.map(rowKey)).toEqual(['t:@0', 'p:%0']);
  });

  it('shows mixed rollups and the useful child decorations', () => {
    const mixedSession: SessionTreeNode = {
      sessionName: 'main',
      windows: [{ id: '@0', index: 0, name: 'editor' }],
      panes: [
        { id: '%0', windowId: '@0', command: 'nvim', cwd: '/code/app/src', active: true },
        {
          id: '%1',
          windowId: '@0',
          command: 'test',
          cwd: '/code/app-worktree/tests',
          active: false,
        },
      ],
    };
    const index = createSidebarTreeIndex([mixedSession], repositories);
    const rows = flattenSidebarTree({
      index,
      windows: [window],
      sessions: [mixedSession],
      sessionName: 'main',
      collapsed: new Set(),
      livePanesByWindow: indexLivePanesByWindow([
        pane,
        { tmuxId: '%1', windowId: '@0' } as TmuxPane,
      ]),
    });

    expect(rows[0]).toMatchObject({
      kind: 'tab',
      gitContext: { kind: 'mixed' },
      showGitBadge: true,
    });
    expect(rows[1]).toMatchObject({
      kind: 'pane',
      gitContext: { kind: 'single', context: { worktree: { branch: 'main' } } },
      showGitBadge: true,
    });
    expect(rows[2]).toMatchObject({
      kind: 'pane',
      gitContext: { kind: 'single', context: { worktree: { branch: 'feature' } } },
      showGitBadge: true,
    });
  });

  it('introduces session rows only when multiple sessions need disambiguation', () => {
    const sessions = [
      session('main', '%0', '@0', '/code/app/src'),
      session('review', '%9', '@9', '/code/app/tests'),
    ];
    sessions[1].windows[0].index = 42;
    const index = createSidebarTreeIndex(sessions, repositories);
    const rows = flattenSidebarTree({
      index,
      windows: [window],
      sessions,
      sessionName: 'main',
      collapsed: new Set(),
      livePanesByWindow: indexLivePanesByWindow([pane]),
    });

    expect(rows.map(rowKey)).toEqual([
      's:main',
      't:@0',
      'p:%0',
      's:review',
      'ft:review:@9',
      'fp:review:%9',
    ]);
    expect(rows.find((row) => rowKey(row) === 'fp:review:%9')).toMatchObject({
      kind: 'foreign-pane',
      cwd: '/code/app/tests',
      gitContext: { kind: 'single' },
    });
    const foreignWindow = rows.find((row) => rowKey(row) === 'ft:review:@9');
    expect(foreignWindow).toMatchObject({
      kind: 'foreign-tab',
      windowId: '@9',
      displayIndex: 1,
    });
    expect(foreignWindow).not.toHaveProperty('index');
  });
});
