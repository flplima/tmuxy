import { TabJumpHint } from './JumpHint';
import { siblingShift, type useReorderDrag } from './useReorderDrag';
import type { TmuxWindow } from '../domain/client';
import { Tooltip } from './Tooltip';
import { InlineRename } from './InlineRename';
import type { WindowId } from '../domain/ids';
import { PaneStateMark } from './PaneStateMark';
import { tabIcon } from './paneTabDisplay';
import { useAppSelector } from '../machines/appHooks';
import { selectKeyBindings } from '../machines/selectors/ui';
import { TmuxOp } from '../domain/commands';
import { keyHint, withKeyHint } from '../domain/keyLabels';
import { commandHint } from './menus/specs/actions';
import { type PaneStateName } from '../domain/paneState';
import type { AppMachineEvent } from '../machines/types/events';
import type { selectTabDrop } from '../machines/selectors/layout';

/** What the tab's busiest pane is doing; while all are idle, the tab's icon. */
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

const ZOOM_TOGGLE = TmuxOp.ZoomToggle({ paneId: null });

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
  const keybindings = useAppSelector(selectKeyBindings);
  const { dragging, dropMarkerAt } = reorder;
  const visualIndex = idx + 1;
  const isDragged = dragging?.windowId === window.id;
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
          onCommit={(name) => send({ type: 'RENAME_TAB_COMMIT', windowId: window.id, name })}
          onCancel={() => send({ type: 'RENAME_TAB_COMMIT', windowId: window.id, name: null })}
        />
      ) : (
        (() => {
          const { icon, label } = tabIcon(window.name, visualIndex);
          return (
            <>
              <TabMark icon={icon} state={tabStates.get(window.id) ?? 'idle'} />
              <TabJumpHint position={visualIndex} />
              <span className="tab-name-label">{label}</span>
            </>
          );
        })()
      )}
      {/* Window state, so a background tab shows them too. */}
      {window.collapsible && (
        <Tooltip label={withKeyHint('Stacked Panes', commandHint(keybindings, 'tab-stack-toggle'))}>
          <span className="tab-flag" aria-label="Stacked Panes">
            {'\uf51e'}
          </span>
        </Tooltip>
      )}
      {window.zoomed && (
        <Tooltip label={withKeyHint('Pane Zoom', keyHint(keybindings, ZOOM_TOGGLE))}>
          <span className="tab-flag" aria-label="Pane Zoom">
            ⛶
          </span>
        </Tooltip>
      )}
    </span>
  );
}
