/**
 * StatusBar - Top bar with the app menu, the two sidebar controls, and the tabs.
 *
 * The bar spans the full window and is divided into the same three columns the
 * body below it has: a left cluster exactly as wide as the left sidebar, the tab
 * list over the pane grid, and a right cluster exactly as wide as the right
 * sidebar. So each sidebar's title and toggle sit above its own column and the
 * dividers line up, and the tab strip stays aligned with the panes.
 *
 * In the desktop app the bar is also the window's title bar (see
 * tmux/desktopWindow.ts): empty space drags the window on every desktop
 * platform, and double-clicking it performs the native title-bar gesture. On
 * macOS the hamburger menu is hidden (the native menu bar is used instead), room
 * is reserved for the traffic-light buttons, and the bar reports its height so
 * those buttons stay centred on it.
 */

import { memo, useCallback } from 'react';
import type { RenderTabline } from '../App';
import {
  useAppSelector,
  selectSidebarLayout,
  selectRightSidebarPane,
} from '../machines/AppContext';
import { getTabText } from './paneTabDisplay';
import { CONTAINER_PADDING_X } from '../constants';
import { isTauri } from '../tmux/adapters';
import {
  isMacTauri,
  reportTitlebarHeight,
  startWindowDrag,
  titlebarDoubleClick,
} from '../tmux/desktopWindow';
import { LogProfiler } from '../utils/renderLog';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import { SidebarToggle } from './SidebarToggle';
import { TabOverviewToggle } from './TabOverviewToggle';
import { SidebarTitle } from './SidebarTitle';
import './StatusBar.css';

/** Interactive chrome inside the bar — clicks on these never drag or zoom the window. */
const CONTROLS =
  'button, [role="tab"], .tab-add, .app-menu-button, .sidebar-toggle, .sidebar-title';

/**
 * A lone tab is a title, not a control: with nothing to switch to, pressing on
 * it should move the window like the header around it. Its buttons (the `+`
 * beside it) stay controls.
 */
const isControl = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  if (target.closest('.tab-list-single .tab-name') && !target.closest('button')) return false;
  return target.closest(CONTROLS) !== null;
};

export const StatusBar = memo(function StatusBar({
  renderTabline,
}: {
  renderTabline?: RenderTabline;
}) {
  const { leftOpen, rightOpen, overlay, leftWidth, rightWidth } =
    useAppSelector(selectSidebarLayout);
  const rightPane = useAppSelector(selectRightSidebarPane);
  const rightTitle = rightPane ? getTabText(rightPane) : 'shell';

  // On the desktop, mousedown on empty bar space hands the click to the OS as
  // a window drag via startDragging(). That swallows the native dblclick before
  // it reaches onDoubleClick — so the second mousedown of a double-click
  // (e.detail === 2) performs the title-bar gesture instead. macOS and Linux
  // share the path (on Linux the window keeps its native decorations, so this
  // is an extra drag handle, not the only one); the Rust side maps the
  // double-click gesture per OS.
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isTauri() || e.buttons !== 1 || isControl(e.target)) return;
    if (e.detail === 2) titlebarDoubleClick();
    else startWindowDrag();
  }, []);

  // Each cluster spans exactly its sidebar's width, so the divider it ends on
  // is the same divider the column below draws — the toggle and title then sit
  // over the panel they belong to (mock 1b/1d). A docked column takes its width
  // out of the tab list, which is what keeps the strip aligned with the pane
  // grid; an overlaying one carries its own header instead, so the header here
  // stays in its closed shape.
  const dockedLeft = leftOpen && !overlay;
  const dockedRight = rightOpen && !overlay;
  // The bar's own 12px inset already covers the gap between the window edge and
  // the column's outer edge, so a cluster spans the column MINUS that inset in
  // order to end exactly on the column's divider.
  const leftCluster = leftWidth - CONTAINER_PADDING_X;
  const rightCluster = rightWidth - CONTAINER_PADDING_X;

  const defaultContent = (
    <>
      <div
        className={`statusbar-cluster statusbar-cluster-left${dockedLeft ? ' is-docked' : ''}`}
        style={dockedLeft ? { flex: `0 0 ${leftCluster}px`, width: leftCluster } : undefined}
      >
        {isMacTauri ? <div className="traffic-light-spacer" /> : <AppMenu />}
        {dockedLeft && <SidebarTitle side="left" />}
        <SidebarToggle side="left" />
      </div>
      <WindowTabs />
      <div
        className={`statusbar-cluster statusbar-cluster-right${dockedRight ? ' is-docked' : ''}`}
        style={dockedRight ? { flex: `0 0 ${rightCluster}px`, width: rightCluster } : undefined}
      >
        <TabOverviewToggle />
        <SidebarToggle side="right" />
        {dockedRight && <SidebarTitle side="right" title={rightTitle} />}
      </div>
    </>
  );

  return (
    <LogProfiler id="StatusBar">
      <div ref={reportTitlebarHeight} className="statusbar" onMouseDown={handleMouseDown}>
        <div className="statusbar-inner">
          {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
        </div>
      </div>
    </LogProfiler>
  );
});
