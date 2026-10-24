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

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { RenderTabline } from '../App';
import { useAppSelector, useReadOnly } from '../machines/appHooks';
import { selectSidebarLayout } from '../machines/selectors/panesAndSidebars';
import { CONTAINER_PADDING_X } from '../constants/layout';
import { isTauri } from '../utils/platform';
import {
  isMacTauri,
  reportTitlebarHeight,
  startWindowDrag,
  titlebarDoubleClick,
} from '../infra/desktopWindow';
import { LogProfiler } from '../utils/renderLog';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import { SidebarToggle } from './SidebarToggle';
import { TabOverviewToggle } from './TabOverviewToggle';
import { NewTabButton } from './NewTabButton';
import { TabStripScroll } from './TabStripScroll';
import { SidebarTitle } from './SidebarTitle';
import { useWindowStyle } from '../utils/guiWindows';
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
  const { leftOpen, rightOpen, leftWidth, rightWidth } = useAppSelector(selectSidebarLayout);
  const readOnly = useReadOnly();
  const leftFocused = useAppSelector((ctx) => ctx.leftSidebarFocused);
  const rightFocused = useAppSelector((ctx) => ctx.rightSidebarFocused);

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
  // is the same divider the column below draws — the title then sits over the
  // panel it belongs to (mock 1b/1d). The toggles do NOT ride the cluster's
  // width: the left one stays at the header's left end (right after the menu)
  // and the right one at its right end, whatever is open, so the same click
  // that opened a column closes it. The "+" and the overview button sit
  // between the strip and the dock's cluster, over the pane area. An open
  // column takes its width out of the tab list, which is what keeps the strip
  // aligned with the pane grid.
  const dockedLeft = leftOpen;
  const windowStyle = useWindowStyle();
  const dockedRight = rightOpen;
  // A cluster spans its column minus whatever sits between the window's edge
  // and the cluster: the bar's own 12px inset, and anything an embedder's
  // `renderTabline` puts there (the demo's traffic lights) — so it ends
  // exactly on the column's divider. Neither depends on the clusters' widths,
  // so measuring them once laid out cannot feed back.
  const innerRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [inset, setInset] = useState({ left: CONTAINER_PADDING_X, right: CONTAINER_PADDING_X });
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => {
      const bar = inner.getBoundingClientRect();
      const left = leftRef.current?.getBoundingClientRect().left;
      const right = rightRef.current?.getBoundingClientRect().right;
      const next = {
        left: left === undefined ? CONTAINER_PADDING_X : left - bar.left,
        right: right === undefined ? CONTAINER_PADDING_X : bar.right - right,
      };
      setInset((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [dockedLeft, dockedRight]);
  const leftCluster = leftWidth - inset.left;
  const rightCluster = rightWidth - inset.right;

  const defaultContent = (
    <>
      <div
        ref={leftRef}
        className={`statusbar-cluster statusbar-cluster-left${dockedLeft ? ' is-docked' : ''}${
          dockedLeft && leftFocused ? ' is-focused' : ''
        }`}
        style={dockedLeft ? { flex: `0 0 ${leftCluster}px`, width: leftCluster } : undefined}
      >
        {/* Room for the traffic lights — unless the No Title Bar style has
            hidden them, when the bar starts at the window's edge. */}
        {isMacTauri ? (
          windowStyle !== 'no-title-bar' && <div className="traffic-light-spacer" />
        ) : (
          <AppMenu />
        )}
        <SidebarToggle side="left" />
        {dockedLeft && <SidebarTitle side="left" />}
      </div>
      <WindowTabs />
      {/* Tab-level actions at the strip's right end: they sit BEFORE the
          dock's cluster, so a docked column never covers them. */}
      <div className="statusbar-actions">
        {/* Before the "+": paging the strip is about the tabs already there,
            and a button that comes and goes must not push the ones that
            do not. */}
        <TabStripScroll />
        {readOnly && (
          <span className="read-only-badge" role="status">
            Read-only
          </span>
        )}
        <NewTabButton />
        <TabOverviewToggle />
      </div>
      <div
        ref={rightRef}
        className={`statusbar-cluster statusbar-cluster-right${dockedRight ? ' is-docked' : ''}${
          dockedRight && rightFocused ? ' is-focused' : ''
        }`}
        style={dockedRight ? { flex: `0 0 ${rightCluster}px`, width: rightCluster } : undefined}
      >
        {dockedRight && <SidebarTitle side="right" />}
        <SidebarToggle side="right" />
      </div>
    </>
  );

  return (
    <LogProfiler id="StatusBar">
      <div ref={reportTitlebarHeight} className="statusbar" onMouseDown={handleMouseDown}>
        <div ref={innerRef} className="statusbar-inner">
          {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
        </div>
      </div>
    </LogProfiler>
  );
});
