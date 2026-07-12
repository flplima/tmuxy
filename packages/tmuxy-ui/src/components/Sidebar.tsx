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

import { memo, useCallback } from 'react';
import { SidebarTree } from './SidebarTree';
import { ServerPicker } from './ServerPicker';
import {
  useAppSend,
  useAppSelector,
  useAppSelectorShallow,
  selectCharSize,
  selectServerList,
  selectCurrentServerId,
} from '../machines/AppContext';
import { SIDEBAR_COLS } from '../machines/constants';
import { isTauri } from '../tmux/adapters';
import { LogProfiler } from '../utils/renderLog';

export const Sidebar = memo(function Sidebar() {
  return (
    <LogProfiler id="Sidebar">
      <SidebarInner />
    </LogProfiler>
  );
});

function SidebarInner() {
  const send = useAppSend();
  const sidebarOpen = useAppSelector((ctx) => ctx.sidebarOpen);
  const sidebarFocused = useAppSelector((ctx) => ctx.sidebarFocused);
  const { charWidth } = useAppSelector(selectCharSize);
  const serverList = useAppSelectorShallow(selectServerList);
  const currentServerId = useAppSelector(selectCurrentServerId);

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

  if (!sidebarOpen) return null;

  // Fixed column width, in lockstep with the tab pane widths (same charWidth).
  const width = SIDEBAR_COLS * charWidth;

  return (
    <aside
      className={`sidebar-fixed${sidebarFocused ? ' is-focused' : ''}`}
      style={{ flex: `0 0 ${width}px`, width, minWidth: width, maxWidth: width }}
      onClick={handleClick}
      data-testid="sidebar-content"
    >
      <div className="sidebar-header">tree</div>
      <SidebarTree focused={sidebarFocused} />
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
