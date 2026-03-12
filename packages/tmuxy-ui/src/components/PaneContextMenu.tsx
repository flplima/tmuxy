/**
 * PaneContextMenu - Right-click context menu for pane operations
 *
 * Uses @szhsin/react-menu ControlledMenu with anchor point positioning.
 */

import { ControlledMenu } from '@szhsin/react-menu';
import '@szhsin/react-menu/dist/index.css';
import {
  useAppSend,
  useAppSelector,
  selectKeyBindings,
  selectVisiblePanes,
} from '../machines/AppContext';
import { executeMenuAction } from './menus/menuActions';
import { PaneMenuItems } from './menus/PaneMenuItems';
import './menus/AppMenu.css';

interface PaneContextMenuProps {
  paneId: string;
  x: number;
  y: number;
  onClose: () => void;
}

export function PaneContextMenu({ paneId, x, y, onClose }: PaneContextMenuProps) {
  const send = useAppSend();
  const keybindings = useAppSelector(selectKeyBindings);
  const visiblePanes = useAppSelector(selectVisiblePanes);
  const isSinglePane = visiblePanes.length <= 1;

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

  return (
    <ControlledMenu state="open" anchorPoint={{ x, y }} onClose={onClose} transition={false}>
      <PaneMenuItems
        keybindings={keybindings}
        isSinglePane={isSinglePane}
        onAction={handleAction}
      />
    </ControlledMenu>
  );
}
