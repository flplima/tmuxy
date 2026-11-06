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
  const inGroup = useAppSelector((ctx) =>
    Object.values(ctx.paneGroups).some((g) => g.paneIds.length > 1 && g.paneIds.includes(paneId)),
  );
  const widgetItems = useWidgetMenuItems(paneId);
  const spec = useAppSelector((ctx) =>
    paneMenuSpec(ctx, { paneId, widgetItems, navigation: false, rename: Boolean(onRename) }),
  );

  const dispatch = useMenuDispatch({
    // Close goes through the group-aware CLOSE_PANE, with no FOCUS_PANE first:
    // that would switch to a hidden group window and confuse the close
    // script's visibility logic.
    closeTarget: paneId,
    // The other actions run on the focused pane. A group member is brought into
    // view as clicking its tab does: `FOCUS_PANE` on a parked member races the
    // swap, and the action lands on the member that was showing.
    before: (command) => {
      if (command === 'pane-close') return;
      send(inGroup ? { type: 'SELECT_PANE_GROUP_TAB', paneId } : { type: 'FOCUS_PANE', paneId });
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
