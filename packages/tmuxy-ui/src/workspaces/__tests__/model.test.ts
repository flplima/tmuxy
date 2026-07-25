import { describe, expect, it } from 'vitest';
import {
  findPaneGitContext,
  isPathInsideWorktree,
  normalizeWorkspacePath,
  summarizeGitContexts,
  type GitRepository,
} from '../model';

const repositories: GitRepository[] = [
  {
    id: 'repo',
    name: 'app',
    root: '/code/app',
    worktrees: [
      {
        path: '/code/app',
        branch: 'main',
        head: 'aaaa',
        isMain: true,
        locked: false,
        prunable: false,
        detached: false,
        bare: false,
      },
      {
        path: '/code/app/packages/ui',
        branch: 'feature',
        head: 'bbbb',
        isMain: false,
        locked: false,
        prunable: false,
        detached: false,
        bare: false,
      },
    ],
  },
];

describe('workspace path mapping', () => {
  it('normalizes paths and only matches complete path components', () => {
    expect(normalizeWorkspacePath('/code//app/./src/../')).toBe('/code/app');
    expect(normalizeWorkspacePath('C:\\code\\app\\src')).toBe('C:/code/app/src');
    expect(isPathInsideWorktree('/code/app/src', '/code/app/')).toBe(true);
    expect(isPathInsideWorktree('/code/app-copy', '/code/app')).toBe(false);
  });

  it('resolves each pane cwd to the longest component-aware worktree path', () => {
    expect(findPaneGitContext('/code/app/src', repositories)?.worktree.branch).toBe('main');
    expect(findPaneGitContext('/code/app/packages/ui/src', repositories)?.worktree.branch).toBe(
      'feature',
    );
    expect(findPaneGitContext('/code/app-copy', repositories)).toBeNull();
  });

  it('rolls homogeneous contexts up and calls partial or distinct contexts mixed', () => {
    const main = findPaneGitContext('/code/app/src', repositories);
    const feature = findPaneGitContext('/code/app/packages/ui/src', repositories);

    expect(summarizeGitContexts([main, main])).toMatchObject({
      kind: 'single',
      context: { worktree: { branch: 'main' } },
    });
    expect(summarizeGitContexts([main, feature])).toMatchObject({
      kind: 'mixed',
      contexts: [{ worktree: { branch: 'main' } }, { worktree: { branch: 'feature' } }],
      unmatchedCount: 0,
    });
    expect(summarizeGitContexts([main, null])).toMatchObject({
      kind: 'mixed',
      contexts: [{ worktree: { branch: 'main' } }],
      unmatchedCount: 1,
    });
    expect(summarizeGitContexts([null, null])).toEqual({ kind: 'none' });
  });
});
