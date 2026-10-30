/**
 * The sidebar tree's row model: row and menu types, row keys and DOM ids, and the git context hook.
 */

import { useCallback, useMemo } from 'react';
import {
  findPaneGitContext,
  gitBadgeText,
  summarizeGitContexts,
  type PaneGitContext,
} from './gitContext';
import type { TmuxPane, TmuxWindow } from '../domain/client';
import type { selectSessions, selectRepositories } from '../machines/selectors/ui';
import type { PaneGroup } from '../machines/types/domain';
import { isPlaceholderId, type PaneId, type WindowId } from '../domain/ids';
import { inGridOrder } from '../utils/gridOrder';

/**
 * A flattened, keyboard-navigable row: the attached session's tabs, each with
 * its panes.
 */
export type Row =
  /** `position` is the tab's 1-based place in the strip — the number the tab
   *  strip shows. tmux's own window index has gaps where chrome windows sit,
   *  and printing it here made the two disagree. */
  | { kind: 'tab'; window: TmuxWindow; position: number; collapsed: boolean }
  /** `parkedBehind`: a group member out of view, listed beside the member in
   *  view (`parkedBehind` is that pane); choosing it switches the group. */
  | { kind: 'pane'; pane: TmuxPane; window: TmuxWindow; last: boolean; parkedBehind?: PaneId };

/**
 * The rows, top to bottom: each tab in strip order, then its panes in grid
 * order. A pane group takes its slot's place with ALL its members, in the
 * group's own order, at the same level as the other panes: the parked ones
 * live in the stash session, so no window of the tab lists them, yet they are
 * the tab's panes. The order is the group's, not "shown first", so switching
 * the member in view does not move rows.
 */
export function buildTreeRows(
  windows: readonly TmuxWindow[],
  panes: readonly TmuxPane[],
  collapsed: ReadonlySet<WindowId>,
  paneGroups: Readonly<Record<string, PaneGroup>>,
): Row[] {
  const out: Row[] = [];
  const byId = new Map(panes.map((p) => [p.tmuxId, p]));
  const groups = Object.values(paneGroups);
  windows.forEach((window, i) => {
    const isCollapsed = collapsed.has(window.id);
    out.push({ kind: 'tab', window, position: i + 1, collapsed: isCollapsed });
    if (isCollapsed) return;
    const listed: Array<{ pane: TmuxPane; parkedBehind?: PaneId }> = [];
    for (const pane of inGridOrder(
      panes.filter((p) => p.windowId === window.id && !isPlaceholderPane(p)),
    )) {
      const group = groups.find((g) => g.paneIds.includes(pane.tmuxId));
      if (!group) {
        listed.push({ pane });
        continue;
      }
      for (const id of group.paneIds) {
        const member = byId.get(id);
        if (!member) continue;
        listed.push(id === pane.tmuxId ? { pane } : { pane: member, parkedBehind: pane.tmuxId });
      }
    }
    listed.forEach(({ pane, parkedBehind }, j) => {
      const last = j === listed.length - 1;
      out.push(
        parkedBehind
          ? { kind: 'pane', pane, window, last, parkedBehind }
          : { kind: 'pane', pane, window, last },
      );
    });
  });
  return out;
}

/** An open right-click menu targeting a tree row, positioned at the cursor. */
export type MenuState =
  | { kind: 'pane'; paneId: PaneId; x: number; y: number }
  | { kind: 'tab'; windowId: WindowId; x: number; y: number }
  | null;

/** DOM id for a row, so the tree can point `aria-activedescendant` at it. */
export const rowDomId = (key: string) => `tree-row-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

/** Optimistic placeholder panes have no identity worth a row; they resolve within a round trip. */
export const isPlaceholderPane = (p: TmuxPane) => isPlaceholderId(p.tmuxId);

/** Stable identity per row, used to preserve the keyboard cursor across refreshes. */
export function rowKey(r: Row): string {
  return r.kind === 'tab' ? r.window.id : r.pane.tmuxId;
}

// Git context per pane, from the poll's cwds and the discovered worktrees.
// The poll is the only place a pane's cwd comes from — live state carries
// none — and it is read for THIS session alone, the one the tree draws.
export function useSidebarGitContext(
  sessions: ReturnType<typeof selectSessions>,
  sessionName: string,
  repositories: ReturnType<typeof selectRepositories>,
) {
  const git = useMemo(() => {
    const byPane = new Map<PaneId, PaneGitContext>();
    const cwdByPane = new Map<PaneId, string>();
    const panesByWindow = new Map<WindowId, PaneId[]>();
    for (const s of sessions.filter((s) => s.sessionName === sessionName)) {
      for (const p of s.panes) {
        const ids = panesByWindow.get(p.windowId) ?? [];
        ids.push(p.id);
        panesByWindow.set(p.windowId, ids);
        if (p.cwd) cwdByPane.set(p.id, p.cwd);
        if (repositories.length === 0) continue;
        const context = findPaneGitContext(p.cwd, repositories);
        if (context) byPane.set(p.id, context);
      }
    }
    return { byPane, cwdByPane, panesByWindow };
  }, [sessions, sessionName, repositories]);

  const branchOf = useCallback(
    (paneIds: readonly PaneId[]): { text: string; title: string } | null => {
      const summary = summarizeGitContexts(paneIds.map((id) => git.byPane.get(id) ?? null));
      if (summary.kind !== 'single') return null;
      const text = gitBadgeText(summary.context);
      return text ? { text, title: summary.context.worktree.path } : null;
    },
    [git],
  );

  return { cwdByPane: git.cwdByPane, branchOf };
}
