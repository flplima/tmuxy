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
    send({ type: 'FOCUS_PANE', paneId });
    executeMenuAction(send, actionId);
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
