/**
 * Pure workspace domain model.
 *
 * This module owns the wire-shaped Git/session summaries and the deterministic
 * mapping from pane working directories to worktrees. It has no React, XState,
 * adapter, or polling dependencies.
 */

export interface SessionTreeWindow {
  id: string;
  index: number;
  name: string;
}

export interface SessionTreePane {
  id: string;
  windowId: string;
  command: string;
  /** Current working directory reported by tmux (`#{pane_current_path}`). */
  cwd: string;
  active: boolean;
}

export interface SessionTreeNode {
  sessionName: string;
  windows: SessionTreeWindow[];
  panes: SessionTreePane[];
}

export interface GitWorktree {
  path: string;
  /** Omitted for detached HEAD and bare repositories. */
  branch?: string;
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  detached: boolean;
  bare: boolean;
}

export interface GitRepository {
  id: string;
  name: string;
  root: string | null;
  worktrees: GitWorktree[];
}

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
  repositories: GitRepository[],
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
 * Roll pane contexts up to a window/session summary.
 *
 * A context is homogeneous only if every pane resolves to the same worktree.
 * A mixture of worktrees, or matched and unmatched panes, is explicitly mixed
 * so a parent badge can never imply that all of its panes share one checkout.
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
