/**
 * Pure model for the visible, flattened sidebar rows.
 *
 * This preserves tmuxy's upstream tree contract: a single attached session is
 * implicit (`window → pane`), while multiple sessions introduce the
 * disambiguating `session → window → pane` level. Git repositories/worktrees
 * decorate those tmux-owned rows; they never own navigation state.
 */

import type { TmuxPane, TmuxWindow } from '../machines/types';
import {
  findPaneGitContext,
  summarizeGitContexts,
  type GitContextSummary,
  type GitRepository,
  type GitWorktree,
  type PaneGitContext,
  type SessionTreeNode,
  type SessionTreePane,
} from '../workspaces/model';

interface GitAwareRow {
  gitContext: GitContextSummary;
  showGitBadge: boolean;
}

export type SidebarTreeRow =
  | ({
      kind: 'session';
      name: string;
      active: boolean;
      depth: number;
    } & GitAwareRow)
  | ({
      kind: 'tab';
      window: TmuxWindow;
      /** Same compact 1-based position rendered by tmuxy's WindowTabs. */
      displayIndex: number;
      depth: number;
    } & GitAwareRow)
  | ({ kind: 'pane'; pane: TmuxPane; window: TmuxWindow; depth: number } & GitAwareRow)
  | ({
      kind: 'foreign-tab';
      sessionName: string;
      windowId: string;
      /** Stable 1-based visual position; navigation still uses windowId. */
      displayIndex: number;
      name: string;
      depth: number;
    } & GitAwareRow)
  | ({
      kind: 'foreign-pane';
      sessionName: string;
      windowId: string;
      paneId: string;
      command: string;
      cwd: string;
      depth: number;
    } & GitAwareRow);

export interface SidebarTreeIndex {
  foreignPanesBySessionAndWindow: Map<string, Map<string, SessionTreePane[]>>;
  paneGitContexts: Map<string, PaneGitContext | null>;
  windowGitSummaries: Map<string, GitContextSummary>;
  sessionGitSummaries: Map<string, GitContextSummary>;
}

export function rowKey(row: SidebarTreeRow): string {
  switch (row.kind) {
    case 'session':
      return `s:${row.name}`;
    case 'tab':
      return `t:${row.window.id}`;
    case 'pane':
      return `p:${row.pane.tmuxId}`;
    case 'foreign-tab':
      return `ft:${row.sessionName}:${row.windowId}`;
    case 'foreign-pane':
      return `fp:${row.sessionName}:${row.paneId}`;
  }
}

export function expandableKey(row: SidebarTreeRow): string | null {
  return row.kind === 'pane' || row.kind === 'foreign-pane' ? null : rowKey(row);
}

export function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || path;
}

export function worktreeLabel(worktree: GitWorktree): string {
  const shortHead = worktree.head.slice(0, 8);
  const ref = worktree.branch?.trim()
    ? worktree.branch
    : worktree.bare
      ? 'bare'
      : worktree.detached
        ? `detached @ ${shortHead || pathBasename(worktree.path)}`
        : shortHead || pathBasename(worktree.path);
  return worktree.isMain ? `${ref} (main)` : ref;
}

export function gitContextLabel(summary: GitContextSummary): string {
  if (summary.kind === 'none') return '';
  if (summary.kind === 'mixed') {
    return summary.contexts.length > 1 ? `mixed · ${summary.contexts.length}` : 'mixed';
  }
  return `${summary.context.repository.name} / ${worktreeLabel(summary.context.worktree)}`;
}

export function gitContextTitle(summary: GitContextSummary): string {
  if (summary.kind === 'none') return 'No Git worktree detected';
  if (summary.kind === 'single') {
    const { repository, worktree } = summary.context;
    return `${repository.name} · ${worktreeLabel(worktree)}\n${worktree.path}`;
  }
  const labels = summary.contexts.map(
    ({ repository, worktree }) => `${repository.name} · ${worktreeLabel(worktree)}`,
  );
  if (summary.unmatchedCount > 0) labels.push(`${summary.unmatchedCount} outside Git`);
  return `Mixed Git context\n${labels.join('\n')}`;
}

function panesByWindow<T extends { windowId: string }>(panes: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const pane of panes) {
    const list = result.get(pane.windowId);
    if (list) list.push(pane);
    else result.set(pane.windowId, [pane]);
  }
  return result;
}

function sessionWindowKey(sessionName: string, windowId: string): string {
  return `${sessionName}\0${windowId}`;
}

/** Index live panes separately because terminal output replaces them frequently. */
export function indexLivePanesByWindow(panes: TmuxPane[]): Map<string, TmuxPane[]> {
  return panesByWindow(panes);
}

/** Build stable session and Git lookups only when slow-changing summaries change. */
export function createSidebarTreeIndex(
  sessions: SessionTreeNode[],
  repositories: GitRepository[],
): SidebarTreeIndex {
  const foreignPanesBySessionAndWindow = new Map<string, Map<string, SessionTreePane[]>>();
  const paneGitContexts = new Map<string, PaneGitContext | null>();
  const windowGitSummaries = new Map<string, GitContextSummary>();
  const sessionGitSummaries = new Map<string, GitContextSummary>();

  for (const session of sessions) {
    const paneMap = panesByWindow(session.panes);
    foreignPanesBySessionAndWindow.set(session.sessionName, paneMap);

    for (const pane of session.panes) {
      paneGitContexts.set(pane.id, findPaneGitContext(pane.cwd, repositories));
    }
    for (const window of session.windows) {
      const contexts = (paneMap.get(window.id) ?? []).map(
        (pane) => paneGitContexts.get(pane.id) ?? null,
      );
      windowGitSummaries.set(
        sessionWindowKey(session.sessionName, window.id),
        summarizeGitContexts(contexts),
      );
    }
    sessionGitSummaries.set(
      session.sessionName,
      summarizeGitContexts(session.panes.map((pane) => paneGitContexts.get(pane.id) ?? null)),
    );
  }

  return {
    foreignPanesBySessionAndWindow,
    paneGitContexts,
    windowGitSummaries,
    sessionGitSummaries,
  };
}

export interface FlattenSidebarTreeInput {
  index: SidebarTreeIndex;
  windows: TmuxWindow[];
  sessions: SessionTreeNode[];
  sessionName: string;
  collapsed: ReadonlySet<string>;
  livePanesByWindow: Map<string, TmuxPane[]>;
}

const NO_GIT_CONTEXT: GitContextSummary = { kind: 'none' };

/**
 * Flatten the tree in tmuxy's native order.
 *
 * Current windows/panes always come from the live control-mode model. The
 * server-wide snapshot contributes only the session grouping, foreign rows,
 * stable window/pane IDs, cwd metadata, and Git decoration.
 */
export function flattenSidebarTree({
  index,
  windows,
  sessions,
  sessionName,
  collapsed,
  livePanesByWindow,
}: FlattenSidebarTreeInput): SidebarTreeRow[] {
  const result: SidebarTreeRow[] = [];

  const appendLiveTree = (sessionSummary: GitContextSummary, depth: number) => {
    for (const [position, window] of windows.entries()) {
      const windowSummary =
        index.windowGitSummaries.get(sessionWindowKey(sessionName, window.id)) ?? NO_GIT_CONTEXT;
      const tab: SidebarTreeRow = {
        kind: 'tab',
        window,
        displayIndex: position + 1,
        depth,
        gitContext: windowSummary,
        showGitBadge: sessionSummary.kind !== 'single' && windowSummary.kind !== 'none',
      };
      result.push(tab);
      if (collapsed.has(rowKey(tab))) continue;
      for (const pane of livePanesByWindow.get(window.id) ?? []) {
        const paneContext = index.paneGitContexts.get(pane.tmuxId) ?? null;
        result.push({
          kind: 'pane',
          pane,
          window,
          depth: depth + 1,
          gitContext: paneContext ? { kind: 'single', context: paneContext } : NO_GIT_CONTEXT,
          showGitBadge:
            sessionSummary.kind !== 'single' &&
            windowSummary.kind !== 'single' &&
            paneContext !== null,
        });
      }
    }
  };

  const appendSession = (session: SessionTreeNode, depth: number) => {
    const active = session.sessionName === sessionName;
    const sessionSummary = index.sessionGitSummaries.get(session.sessionName) ?? NO_GIT_CONTEXT;
    const sessionRow: SidebarTreeRow = {
      kind: 'session',
      name: session.sessionName,
      active,
      depth,
      gitContext: sessionSummary,
      showGitBadge: sessionSummary.kind !== 'none',
    };
    result.push(sessionRow);
    if (collapsed.has(rowKey(sessionRow))) return;

    if (active) {
      appendLiveTree(sessionSummary, depth + 1);
      return;
    }

    const paneMap = index.foreignPanesBySessionAndWindow.get(session.sessionName);
    for (const [position, window] of session.windows.entries()) {
      const windowSummary =
        index.windowGitSummaries.get(sessionWindowKey(session.sessionName, window.id)) ??
        NO_GIT_CONTEXT;
      const tab: SidebarTreeRow = {
        kind: 'foreign-tab',
        sessionName: session.sessionName,
        windowId: window.id,
        displayIndex: position + 1,
        name: window.name,
        depth: depth + 1,
        gitContext: windowSummary,
        showGitBadge: sessionSummary.kind !== 'single' && windowSummary.kind !== 'none',
      };
      result.push(tab);
      if (collapsed.has(rowKey(tab))) continue;
      for (const pane of paneMap?.get(window.id) ?? []) {
        const paneContext = index.paneGitContexts.get(pane.id) ?? null;
        result.push({
          kind: 'foreign-pane',
          sessionName: session.sessionName,
          windowId: window.id,
          paneId: pane.id,
          command: pane.command,
          cwd: pane.cwd,
          depth: depth + 2,
          gitContext: paneContext ? { kind: 'single', context: paneContext } : NO_GIT_CONTEXT,
          showGitBadge:
            sessionSummary.kind !== 'single' &&
            windowSummary.kind !== 'single' &&
            paneContext !== null,
        });
      }
    }
  };

  // Keep the common single-session case flat. A session row is useful only
  // when sibling sessions actually need disambiguation.
  if (sessions.length <= 1) {
    const activeSummary =
      index.sessionGitSummaries.get(sessionName) ??
      (sessions[0]
        ? (index.sessionGitSummaries.get(sessions[0].sessionName) ?? NO_GIT_CONTEXT)
        : NO_GIT_CONTEXT);
    appendLiveTree(activeSummary, 0);
    return result;
  }

  const hasActiveSession = sessions.some((session) => session.sessionName === sessionName);
  if (!hasActiveSession) {
    appendSession({ sessionName, windows: [], panes: [] }, 0);
  }
  for (const session of sessions) appendSession(session, 0);
  return result;
}
