/**
 * WindowTabItem — individual tab item and active-tab scroll-into-view hook
 * for WindowTabs.
 */

import { TmuxOp } from '../domain/commands';
import { siblingShift, type useReorderDrag } from '../hooks/useReorderDrag';
import type { TmuxWindow } from '../domain/client';
import { Tooltip } from './Tooltip';
import { InlineRename } from './InlineRename';
import type { WindowId } from '../domain/ids';
import { PaneStateMark } from './PaneStateMark';
import { tabIcon } from './paneTabDisplay';
import { type PaneStateName } from '../utils/paneState';
import type { AppMachineEvent } from '../machines/types/events';
import type { selectTabDrop } from '../machines/selectors/layout';

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

interface WindowTabItemProps {
  window: TmuxWindow;
  idx: number;
  visibleWindowsLength: number;
  previewId: string | null;
  renamingId: WindowId | null;
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
            send({ type: 'TAB_RENAME_END' });
            send({
              type: 'DISPATCH_OP',
              op: TmuxOp.RenameWindow({ target: window.id, name }),
            });
          }}
          onCancel={() => send({ type: 'TAB_RENAME_END' })}
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
