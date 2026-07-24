/**
 * Sidebar - left FIXED column rendering the tab/pane tree.
 *
 * When open, the sidebar is a full-height, fixed-width column that is part of
 * the app layout (a flex sibling of the pane area) — NOT an overlay. Because the
 * pane container flexes into the REMAINING width, its ResizeObserver reports the
 * reduced size and tmux re-tiles the panes to fit; the panes never render under
 * the sidebar. The tree itself is a native React component derived from state —
 * no tmux window/pane, no `tmuxy tree` TUI. Toggled from the header button or
 * `prefix t`; focused via a click or Ctrl+h from the leftmost pane.
 */

import { memo, useCallback, useMemo } from 'react';
import { SidebarTree } from './SidebarTree';
import { ServerPicker } from './ServerPicker';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectCharSize,
  selectServerList,
  selectCurrentServerId,
  selectSessions,
  selectRepositories,
} from '../machines/AppContext';
import { SIDEBAR_COLS } from '../machines/constants';
import { isTauri } from '../tmux/adapters';
import { LogProfiler } from '../utils/renderLog';
import { createSidebarTreeIndex, gitContextLabel, gitContextTitle } from './sidebarTreeModel';

export const Sidebar = memo(function Sidebar() {
  // Keep the closed sidebar subscription surface to one boolean. Session and
  // workspace updates should not rerender an invisible tree.
  const sidebarOpen = useAppSelector((context) => context.sidebarOpen);
  if (!sidebarOpen) return null;

  return (
    <LogProfiler id="Sidebar">
      <SidebarInner />
    </LogProfiler>
  );
});

function SidebarInner() {
  const send = useAppSend();
  const sidebarFocused = useAppSelector((ctx) => ctx.sidebarFocused);
  const { charWidth } = useAppSelector(selectCharSize);
  const serverList = useAppSelectorShallow(selectServerList);
  const currentServerId = useAppSelector(selectCurrentServerId);
  const sessions = useAppSelectorShallow(selectSessions);
  const repositories = useAppSelectorShallow(selectRepositories);
  const sessionName = useAppSelector((context) => context.sessionName);

  // Fixed column width, in lockstep with the tab pane widths (same charWidth).
  const width = SIDEBAR_COLS * charWidth;
  const treeIndex = useMemo(
    () => createSidebarTreeIndex(sessions, repositories),
    [repositories, sessions],
  );
  const activeGitContext = treeIndex.sessionGitSummaries.get(sessionName);
  const showHeaderContext =
    sessions.length <= 1 && activeGitContext && activeGitContext.kind !== 'none';

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      send({ type: 'FOCUS_SIDEBAR' });
    },
    [send],
  );

  // Reconnect the desktop app to a saved server. A Tauri-only, non-tmux command
  // — invoked directly (the sanctioned escape hatch for desktop-only calls, as
  // in StatusBar's window controls), since it needs no optimistic state.
  const handleSelectServer = useCallback((id: string) => {
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('connect_server', { id }));
  }, []);

  const handleAddServer = useCallback(() => {
    send({ type: 'OPEN_ADD_SERVER_FLOAT' });
  }, [send]);

  return (
    <aside
      className={`sidebar-fixed${sidebarFocused ? ' is-focused' : ''}`}
      style={{ flex: `0 0 ${width}px`, width, minWidth: width, maxWidth: width }}
      onClick={handleClick}
      data-testid="sidebar-content"
      data-sidebar-width={width}
    >
      <div className="sidebar-header">
        <span className="sidebar-header-label">tree</span>
        {showHeaderContext && activeGitContext && (
          <span className="sidebar-header-context" title={gitContextTitle(activeGitContext)}>
            {gitContextLabel(activeGitContext)}
          </span>
        )}
      </div>
      <SidebarTree focused={sidebarFocused} index={treeIndex} />
      {/* Server picker is desktop-only; the web build is fixed to its socket. */}
      {isTauri() && (
        <ServerPicker
          servers={serverList}
          currentId={currentServerId}
          onSelect={handleSelectServer}
          onAddServer={handleAddServer}
        />
      )}
    </aside>
  );
}
