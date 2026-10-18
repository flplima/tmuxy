/**
 * WindowTabItem — individual tab item and active-tab scroll-into-view hook
 * for WindowTabs.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';
import { TmuxOp } from '../domain/commands';
import { siblingShift, type useReorderDrag } from '../hooks/useReorderDrag';
import type { TmuxWindow } from '../domain/client';
import { Tooltip } from './Tooltip';
import { InlineRename } from './InlineRename';
import type { WindowId } from '../domain/ids';
import { PaneStateMark } from './PaneStateMark';
import { tabIcon } from './paneTabDisplay';
import { tabPaneStates, type PaneStateName } from '../utils/paneState';
import type { AppMachineContext } from '../machines/types/context';
import type { AppMachineEvent } from '../machines/types/events';
import type { selectTabDrop } from '../machines/selectors/layout';

/**
 * How long the strip keeps checking that the current tab is still in view
 * after a switch. Long enough for the layout around it to settle, short
 * enough that a scroll the user makes afterwards is left alone.
 */
const SHOW_ACTIVE_TAB_SETTLE_MS = 600;

/**
 * Memoized (no props): context.windows gets a fresh array identity on every
 * model tick; the shallow selectors below keep re-renders to actual window
 * changes, and the memo shields against parent re-renders.
 */
/** Each tab's rolled-up pane state, as `<window id>=<state>` entries: equal
 *  item by item across updates that change pane content but no state, so the
 *  strip holds still. */
export function selectTabStates(context: AppMachineContext): string[] {
  const states = tabPaneStates(
    context.windows.map((w) => w.id),
    context.panes,
    context.unreadPaneIds,
  );
  return [...states].map(([id, { state }]) => `${id}=${state}`);
}

/**
 * The tab's mark: what its busiest pane is doing — the tree's marks, with a
 * question or a failure ahead of work in progress — and while all of them are
 * idle, the tab's icon (`tabIcon`).
 */
function TabMark({ icon, state }: { icon: string; state: PaneStateName }) {
  if (state !== 'idle') return <PaneStateMark state={state} className="tab-mark" />;
  return (
    <span className="tab-mark" aria-hidden="true">
      {icon}
    </span>
  );
}

// ---- keep the current tab reachable --------------------------------------
// With more tabs than fit, switching by keyboard (ctrl+N, prefix n/p) can
// land on a tab that is scrolled off the strip: the tab you are now looking
// at would be the one you cannot see.
export function useShowActiveTab(
  listRef: React.RefObject<HTMLDivElement | null>,
  activeWindowId: WindowId | null,
  animationsAllowed: boolean,
  visibleWindowsLength: number,
) {
  /**
   * Bring the current tab into view, and say whether it already was.
   *
   * The move is a DELTA rather than an absolute target, so each call re-aims
   * from wherever the strip has got to — which matters because the strip is
   * still settling on the commit that switches tabs, and because a smooth
   * scroll is in flight while it does.
   */
  const showActiveTab = useCallback((): boolean => {
    const list = listRef.current;
    if (!list || !activeWindowId) return true;
    if (list.scrollWidth <= list.clientWidth) return true;
    const tab = list.querySelector<HTMLElement>(`.tab-name[data-window-id="${activeWindowId}"]`);
    if (!tab) return true;
    const tabBox = tab.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const behind = listBox.left - tabBox.left;
    const past = tabBox.right - listBox.right;
    if (behind <= 0 && past <= 0) return true;
    list.scrollTo({
      left: list.scrollLeft + (behind > 0 ? -behind : past),
      behavior: animationsAllowed ? 'smooth' : 'auto',
    });
    return false;
  }, [listRef, activeWindowId, animationsAllowed]);

  useLayoutEffect(() => {
    // Keep re-aiming until it sticks, for a moment. The strip's width, the
    // pager buttons and the tabs' own boxes all land over the next paint or
    // two, and each of them can push a tab that was just brought to the edge
    // back off it — the strip growing WIDER is not a resize of the strip, so
    // nothing else would notice. Bounded, so a scroll the user makes later is
    // never yanked back.
    const deadline = performance.now() + SHOW_ACTIVE_TAB_SETTLE_MS;
    let raf = requestAnimationFrame(function again() {
      const settled = showActiveTab();
      if (!settled || performance.now() < deadline) raf = requestAnimationFrame(again);
    });
    showActiveTab();
    return () => cancelAnimationFrame(raf);
  }, [showActiveTab, visibleWindowsLength]);

  // ...and again whenever the strip changes size under it. The pager buttons
  // are the reason: they appear precisely BECAUSE the strip overflows, and
  // they take their width out of it, so a tab scrolled to the edge a moment
  // earlier is pushed back off it. A window resize and a sidebar opening do
  // the same thing.
  const showActiveTabRef = useRef(showActiveTab);
  showActiveTabRef.current = showActiveTab;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => showActiveTabRef.current());
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef]);
}

interface WindowTabItemProps {
  window: TmuxWindow;
  idx: number;
  visibleWindowsLength: number;
  previewId: string | null;
  renamingId: WindowId | null;
  setRenamingId: (id: WindowId | null) => void;
  tabStates: Map<string, PaneStateName>;
  tabDrop: ReturnType<typeof selectTabDrop>;
  reorder: ReturnType<typeof useReorderDrag>;
  handlePointerDown: (e: React.PointerEvent<HTMLSpanElement>, index: number) => void;
  handlePointerUp: (e: React.PointerEvent<HTMLSpanElement>) => void;
  handleTabEnter: (e: React.PointerEvent<HTMLSpanElement>, windowId: WindowId) => void;
  handleWindowClick: (window: TmuxWindow) => void;
  handleContextMenu: (e: React.MouseEvent, windowId: WindowId) => void;
  send: (event: AppMachineEvent) => void;
}

export function WindowTabItem({
  window,
  idx,
  visibleWindowsLength,
  previewId,
  renamingId,
  setRenamingId,
  tabStates,
  tabDrop,
  reorder,
  handlePointerDown,
  handlePointerUp,
  handleTabEnter,
  handleWindowClick,
  handleContextMenu,
  send,
}: WindowTabItemProps) {
  const { dragging, dropMarkerAt } = reorder;
  const visualIndex = idx + 1;
  const isDragged = dragging?.windowId === window.id;
  // The strip shows the order the drop would make while the drag is
  // on: every tab the dragged one has passed slides out of its way by
  // the dragged tab's width, so the drop only confirms what is seen.
  const shift = dragging && !isDragged ? siblingShift(dragging, idx) : 0;
  const style = isDragged
    ? { transform: `translateX(${dragging!.dx}px)` }
    : dragging
      ? { transform: `translateX(${shift * dragging.size}px)` }
      : undefined;
  const className = [
    'tab-name',
    window.active ? 'tab-name-active' : '',
    previewId === window.id ? 'is-previewing' : '',
    isDragged ? 'is-dragging' : '',
    dragging && !isDragged ? 'is-making-way' : '',
    tabDrop?.kind === 'tab' && tabDrop.windowId === window.id ? 'is-pane-drop-target' : '',
    dropMarkerAt === idx ? 'is-drop-before' : '',
    dropMarkerAt === visibleWindowsLength && idx === visibleWindowsLength - 1
      ? 'is-drop-after'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      data-window-id={window.id}
      className={className}
      style={style}
      onPointerDown={(e) => handlePointerDown(e, idx)}
      onPointerMove={reorder.handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={reorder.handlePointerCancel}
      onPointerEnter={(e) => handleTabEnter(e, window.id)}
      onClick={() => handleWindowClick(window)}
      onContextMenu={(e) => handleContextMenu(e, window.id)}
      role="tab"
      aria-selected={window.active}
      aria-label={`Tab ${visualIndex}: ${window.name}${window.active ? ' (active)' : ''}`}
    >
      {renamingId === window.id ? (
        <InlineRename
          className="tab-name-input"
          value={window.name}
          ariaLabel={`Rename tab ${visualIndex}`}
          onCommit={(name) => {
            setRenamingId(null);
            send({
              type: 'DISPATCH_OP',
              op: TmuxOp.RenameWindow({ target: window.id, name }),
            });
          }}
          onCancel={() => setRenamingId(null)}
        />
      ) : (
        (() => {
          const { icon, label } = tabIcon(window.name, visualIndex);
          return (
            <>
              <TabMark icon={icon} state={tabStates.get(window.id) ?? 'idle'} />
              <span className="tab-name-label">{label}</span>
            </>
          );
        })()
      )}
      {/* What this tab is doing that its name does not say. Both are
          window state, so a background tab shows them too. */}
      {window.collapsible && (
        <Tooltip label="Stacked Panes (prefix+S to toggle)">
          <span className="tab-flag" aria-label="Stacked Panes">
            {'\uf51e'}
          </span>
        </Tooltip>
      )}
      {window.zoomed && (
        <Tooltip label="Pane Zoom (prefix+z to toggle)">
          <span className="tab-flag" aria-label="Pane Zoom">
            ⛶
          </span>
        </Tooltip>
      )}
    </span>
  );
}
