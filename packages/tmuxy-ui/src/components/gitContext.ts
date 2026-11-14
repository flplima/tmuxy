/**
 * The host discovers the repositories (`tmuxy-core/src/worktrees.rs`,
 * published as `repositories` by the sessions poll); this decides which
 * worktree a pane cwd sits in and what a sidebar row's badge shows.
 */

import type { GitRepository, GitWorktree } from '../domain/servers';

export interface PaneGitContext {
  repository: GitRepository;
  worktree: GitWorktree;
}

export type GitContextSummary =
  | { kind: 'none' }
  | { kind: 'single'; context: PaneGitContext }
  | {
      kind: 'mixed';
      /** Distinct matched worktrees, not pane count. */
      contexts: PaneGitContext[];
      /** Panes whose cwd did not resolve to a discovered worktree. */
      unmatchedCount: number;
    };

/**
 * Lexical, for component-aware prefix comparison: the backend canonicalizes
 * discovered Git paths, while tmux reports the pane cwd as it is.
 */
export function normalizeWorkspacePath(input: string): string {
  const replaced = input.trim().replace(/\\/g, '/');
  if (!replaced) return '';

  const absolute = replaced.startsWith('/');
  const driveMatch = replaced.match(/^([A-Za-z]:)(?:\/|$)/);
  const drive = driveMatch?.[1] ?? '';
  const start = drive ? drive.length : 0;
  const segments: string[] = [];
  for (const segment of replaced.slice(start).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop();
      else if (!absolute && !drive) segments.push(segment);
      continue;
    }
    segments.push(segment);
  }

  const prefix = drive ? `${drive}/` : absolute ? '/' : '';
  const normalized = `${prefix}${segments.join('/')}`;
  return normalized || (absolute ? '/' : drive ? `${drive}/` : '.');
}

export function isPathInsideWorktree(path: string, worktreePath: string): boolean {
  const candidate = normalizeWorkspacePath(path);
  const root = normalizeWorkspacePath(worktreePath);
  if (!candidate || !root || candidate === '.' || root === '.') return candidate === root;
  if (candidate === root) return true;
  return root === '/' ? candidate.startsWith('/') : candidate.startsWith(`${root}/`);
}

/** The longest matching root wins, so nested worktrees beat their parent checkout. */
export function findPaneGitContext(
  cwd: string,
  repositories: readonly GitRepository[],
): PaneGitContext | null {
  let best: { context: PaneGitContext; pathLength: number } | null = null;
  for (const repository of repositories) {
    for (const worktree of repository.worktrees) {
      const root = normalizeWorkspacePath(worktree.path);
      if (!root || root === '.' || !isPathInsideWorktree(cwd, root)) continue;
      if (!best || root.length > best.pathLength) {
        best = { context: { repository, worktree }, pathLength: root.length };
      }
    }
  }
  return best?.context ?? null;
}

function gitContextKey(context: PaneGitContext): string {
  return `${context.repository.id}:${normalizeWorkspacePath(context.worktree.path)}`;
}

/**
 * Matched and unmatched panes together are `mixed`, so a tab badge never
 * implies that all of its panes share one checkout.
 */
export function summarizeGitContexts(
  paneContexts: ReadonlyArray<PaneGitContext | null>,
): GitContextSummary {
  if (paneContexts.length === 0 || paneContexts.every((context) => context === null)) {
    return { kind: 'none' };
  }

  const contexts = new Map<string, PaneGitContext>();
  let unmatchedCount = 0;
  for (const context of paneContexts) {
    if (!context) {
      unmatchedCount += 1;
      continue;
    }
    contexts.set(gitContextKey(context), context);
  }

  if (contexts.size === 1 && unmatchedCount === 0) {
    return { kind: 'single', context: [...contexts.values()][0] };
  }
  return { kind: 'mixed', contexts: [...contexts.values()], unmatchedCount };
}

/**
 * A checkout's uncommitted lines as the row shows them: `+12` and `−3`, each
 * left out when it is zero, and nothing at all for a clean checkout or one
 * the host did not count.
 */
export function gitChangesText(context: PaneGitContext): { added: string; removed: string } | null {
  const changes = context.worktree.changes;
  if (!changes || (changes.added === 0 && changes.removed === 0)) return null;
  return {
    added: changes.added > 0 ? `+${changes.added}` : '',
    removed: changes.removed > 0 ? `\u2212${changes.removed}` : '',
  };
}

/** Empty for a bare repository. */
export function gitBadgeText(context: PaneGitContext): string {
  const { worktree } = context;
  if (worktree.branch) return worktree.branch;
  if (worktree.detached) return worktree.head.slice(0, 7);
  return '';
}
