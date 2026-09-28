/**
 * PaneContextMenu - Right-click context menu for pane operations
 *
 * A floating surface anchored at the point that was right-clicked
 * (components/floating/Menu) — the same object as every other menu and the tab
 * preview, so opening it puts whichever of those was up away.
 */

import { FloatingMenu } from './floating/Menu';
import {
  useAppSend,
  useAppSelector,
  selectKeyBindings,
  selectVisiblePanes,
  selectMarkedPaneId,
} from '../machines/AppContext';
import { executeMenuAction } from './menus/menuActions';
import { PaneMenuItems } from './menus/PaneMenuItems';
import { useWidgetMenuItems } from './widgets/usePaneWidget';
import type { WidgetMenuItem } from './widgets';

interface PaneContextMenuProps {
  paneId: string;
  x: number;
  y: number;
  onClose: () => void;
  /** Start renaming this pane in its own header; the header owns the field. */
  onRename?: () => void;
}

export function PaneContextMenu({ paneId, x, y, onClose, onRename }: PaneContextMenuProps) {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const isSinglePane = visiblePanes.length <= 1;
  const markedPaneId = useAppSelector(selectMarkedPaneId);
  // A pane running a widget gets that widget's own section at the top.
  const widgetItems = useWidgetMenuItems(paneId);

  const handleAction = (actionId: string) => {
    if (actionId === 'pane-close') {
      // Route through group-aware CLOSE_PANE instead of raw kill-pane.
      // Don't FOCUS_PANE first — that would switch to a hidden group window
      // and confuse the close script's visibility logic.
      send({ type: 'CLOSE_PANE', paneId });
    } else {
      send({ type: 'FOCUS_PANE', paneId });
      executeMenuAction(send, actionId);
    }
    onClose();
  };

  const handleWidgetAction = (item: WidgetMenuItem) => {
    send(item.event);
    onClose();
  };

  return (
    <FloatingMenu
      id="pane-context-menu"
      label="Pane"
      anchor={{ kind: 'point', x, y }}
      onClose={onClose}
    >
      <PaneMenuItems
        keybindings={keybindings}
        isSinglePane={isSinglePane}
        widgetItems={widgetItems}
        onWidgetAction={handleWidgetAction}
        isMarked={markedPaneId === paneId}
        hasMarked={markedPaneId !== null}
        onRename={
          onRename &&
          (() => {
            onRename();
            onClose();
          })
        }
        onAction={handleAction}
      />
    </FloatingMenu>
  );
}
