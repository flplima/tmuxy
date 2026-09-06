/**
 * Matching pane working directories to git worktrees — the pure half of the
 * sidebar tree's branch badges. The host discovers the repositories
 * (`tmuxy-core/src/worktrees.rs`, published as `repositories` by the sessions
 * poll); this decides which worktree a pane cwd sits in and what a row shows.
 * No React, no machine, no adapter.
 */

import type { GitRepository, GitWorktree } from '../machines/types';

/** Git identity resolved for a single pane cwd. */
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
 * Normalize a filesystem path for component-aware prefix comparison.
 *
 * This is deliberately lexical: the backend canonicalizes discovered Git
 * paths, while tmux reports an existing pane cwd. Removing `.`/`..`, duplicate
 * separators and trailing slashes prevents `/repo-copy` from matching `/repo`.
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

/** True when `path` is the worktree root or one of its descendants. */
export function isPathInsideWorktree(path: string, worktreePath: string): boolean {
  const candidate = normalizeWorkspacePath(path);
  const root = normalizeWorkspacePath(worktreePath);
  if (!candidate || !root || candidate === '.' || root === '.') return candidate === root;
  if (candidate === root) return true;
  return root === '/' ? candidate.startsWith('/') : candidate.startsWith(`${root}/`);
}

/**
 * Resolve a pane cwd to the most specific discovered worktree.
 *
 * Matching is component-aware (`/repo-copy` never matches `/repo`) and the
 * longest matching root wins, so nested worktrees beat their parent checkout.
 */
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

/** Stable identity for comparing contexts without relying on object identity. */
export function gitContextKey(context: PaneGitContext): string {
  return `${context.repository.id}:${normalizeWorkspacePath(context.worktree.path)}`;
}

/**
 * Roll pane contexts up to a window summary.
 *
 * A context is homogeneous only if every pane resolves to the same worktree.
 * A mixture of worktrees, or matched and unmatched panes, is explicitly mixed
 * so a tab badge can never imply that all of its panes share one checkout.
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
 * What a row's badge says for a worktree: its branch, else the short head of
 * a detached checkout, else nothing for a bare repository.
 */
export function gitBadgeText(context: PaneGitContext): string {
  const { worktree } = context;
  if (worktree.branch) return worktree.branch;
  if (worktree.detached) return worktree.head.slice(0, 7);
  return '';
}
