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
  const widgetItems = useWidgetMenuItems(paneId);
  const spec = useAppSelector((ctx) =>
    paneMenuSpec(ctx, { paneId, widgetItems, navigation: false, rename: Boolean(onRename) }),
  );

  const dispatch = useMenuDispatch({
    // The menu's ops run on the focused pane, so the pane is picked first,
    // as a click on it would. Close Pane is an event naming the pane: picking
    // it first would switch to a hidden group window and confuse the close
    // script's visibility logic.
    before: () => send({ type: 'SELECT_PANE', paneId }),
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
