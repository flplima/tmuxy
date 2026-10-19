/**
 * PaneContextMenu — the right-click (and ⋮) menu of one pane: the pane spec
 * without the navigation items, drawn at the pointer.
 */

import { FloatingMenu } from './floating/Menu';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import { paneMenuSpec } from '../domain/menus/paneMenu';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
import { useWidgetMenuItems } from './widgets/usePaneWidget';
import { useNativeMenu } from './menus/useNativeMenu';
import type { PaneId } from '../domain/ids';

interface PaneContextMenuProps {
  paneId: PaneId;
  x: number;
  y: number;
  onClose: () => void;
  /** Start renaming this pane in its own header; the header owns the field. */
  onRename?: () => void;
}

export function PaneContextMenu({ paneId, x, y, onClose, onRename }: PaneContextMenuProps) {
  const send = useAppSend();
  const inGroup = useAppSelector((ctx) =>
    Object.values(ctx.paneGroups).some((g) => g.paneIds.length > 1 && g.paneIds.includes(paneId)),
  );
  // A pane running a widget gets that widget's own section at the top.
  const widgetItems = useWidgetMenuItems(paneId);
  const spec = useAppSelector((ctx) =>
    paneMenuSpec(ctx, { paneId, widgetItems, navigation: false, rename: Boolean(onRename) }),
  );

  const dispatch = useMenuDispatch({
    // Route Close Pane through group-aware CLOSE_PANE instead of raw
    // kill-pane. Don't FOCUS_PANE first — that would switch to a hidden
    // group window and confuse the close script's visibility logic.
    closeTarget: paneId,
    // The menu's other actions run on the focused pane. A group member is
    // brought into view the way clicking its tab does — `FOCUS_PANE` on a
    // parked member would race the swap, and the action would land on the
    // member that was showing instead of the one the menu was opened for.
    before: (actionId) => {
      if (actionId === 'pane-close') return;
      send(inGroup ? { type: 'SELECT_PANE_GROUP_TAB', paneId } : { type: 'FOCUS_PANE', paneId });
    },
    onLocal: (id) => {
      if (id === 'pane-rename') onRename?.();
    },
  });

  const choose = (action: Parameters<typeof dispatch>[0]) => {
    dispatch(action);
    onClose();
  };
  const inApp = useNativeMenu(spec, choose, { x, y }, onClose);
  if (!inApp) return null;

  return (
    <FloatingMenu
      id="pane-context-menu"
      label="Pane"
      anchor={{ kind: 'point', x, y }}
      onClose={onClose}
    >
      {renderSpec(spec, choose)}
    </FloatingMenu>
  );
}
