/**
 * PaneContextMenu — the right-click (and ⋮) menu of one pane: the pane spec
 * without the navigation items, drawn at the pointer.
 */

import { FloatingMenu } from './floating/Menu';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import { paneMenuSpec } from './menus/specs/paneMenu';
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
  // A pane running a widget gets that widget's own section at the top.
  const widgetItems = useWidgetMenuItems(paneId);
  const spec = useAppSelector((ctx) =>
    paneMenuSpec(ctx, { paneId, widgetItems, navigation: false, rename: Boolean(onRename) }),
  );

  const dispatch = useMenuDispatch({
    // Route Close Pane through group-aware CLOSE_PANE instead of raw
    // kill-pane. Don't select the pane first — that would switch to a hidden
    // group window and confuse the close script's visibility logic.
    closeTarget: paneId,
    // The menu's other actions run on the focused pane, so the pane is
    // picked first, as a click on it would.
    before: (command) => {
      if (command === 'pane-close') return;
      send({ type: 'SELECT_PANE', paneId });
    },
    onLocal: (local) => {
      if (local.verb === 'rename') onRename?.();
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
