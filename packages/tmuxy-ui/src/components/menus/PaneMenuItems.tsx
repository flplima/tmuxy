/**
 * PaneMenuItems - Shared pane menu items used by AppMenu, PaneContextMenu, and PaneHeader icon menu.
 */

import { MenuItem, MenuDivider } from '../floating/Menu';
import type { KeyBindings } from '../../machines/types';
import type { WidgetMenuItem } from '../widgets';
import { KeyLabel } from './KeyLabel';
import { MENU_OPS } from './menuActions';
import { TmuxOp } from '../../domain/commands';

interface PaneMenuItemsProps {
  keybindings: KeyBindings | null;
  isSinglePane: boolean;
  /**
   * The pane's widget's own items, shown as a section above the generic ones
   * (see components/widgets — a widget contributes these by name, nothing here
   * knows which widget is running).
   */
  widgetItems?: WidgetMenuItem[];
  /** Called with the chosen widget item; its `event` is what to dispatch. */
  onWidgetAction?: (item: WidgetMenuItem) => void;
  /** Start renaming the pane where its title is drawn; the header owns the
   *  field. Absent where there is no title on screen to edit (the app menu). */
  onRename?: () => void;
  /** The pane these items act on is tmux's marked pane. */
  isMarked?: boolean;
  /** Some pane (possibly another one) is marked, so swap/join with it make sense. */
  hasMarked?: boolean;
  onAction: (actionId: string) => void;
}

export function PaneMenuItems({
  keybindings,
  isSinglePane,
  widgetItems,
  onWidgetAction,
  onRename,
  isMarked = false,
  hasMarked = false,
  onAction,
}: PaneMenuItemsProps) {
  return (
    <>
      {widgetItems && widgetItems.length > 0 && (
        <>
          {widgetItems.map((item) => (
            <MenuItem
              key={item.id}
              disabled={item.disabled}
              data-widget-action={item.id}
              onClick={() => onWidgetAction?.(item)}
            >
              {item.label}
              {item.keyHint && <span className="menu-keybinding">{item.keyHint}</span>}
            </MenuItem>
          ))}
          <MenuDivider />
        </>
      )}
      {onRename && (
        <>
          <MenuItem onClick={onRename}>Rename Pane</MenuItem>
          <MenuDivider />
        </>
      )}
      <MenuItem onClick={() => onAction('pane-split-below')}>
        Split Pane Below
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-split-below']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-split-right')}>
        Split Pane Right
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-split-right']} />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-next')} disabled={isSinglePane}>
        Next Pane
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-next']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-previous')} disabled={isSinglePane}>
        Previous Pane
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-previous']} />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-swap-prev')} disabled={isSinglePane}>
        Swap with Previous
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-swap-prev']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-swap-next')} disabled={isSinglePane}>
        Swap with Next
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-swap-next']} />
      </MenuItem>
      <MenuDivider />
      {isMarked ? (
        <MenuItem onClick={() => onAction('pane-unmark')}>
          Unmark Pane
          <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-unmark']} />
        </MenuItem>
      ) : (
        <MenuItem onClick={() => onAction('pane-mark')}>
          Mark Pane
          <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-mark']} />
        </MenuItem>
      )}
      <MenuItem onClick={() => onAction('pane-swap-marked')} disabled={!hasMarked || isMarked}>
        Swap with Marked Pane
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-join-marked')} disabled={!hasMarked || isMarked}>
        Join Marked Pane Here
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-move-new-tab')}>
        Move to New Tab
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-move-new-tab']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-add-to-group')}>Add Pane to Group</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-copy-mode')}>
        Copy Mode
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-copy-mode']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-paste')}>
        Paste
        <KeyLabel keybindings={keybindings} op={MENU_OPS['pane-paste']} />
      </MenuItem>
      <MenuItem onClick={() => onAction('pane-clear')}>Clear Screen</MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('view-zoom')}>
        Zoom Pane
        <KeyLabel keybindings={keybindings} op={MENU_OPS['view-zoom']} />
      </MenuItem>
      <MenuDivider />
      <MenuItem onClick={() => onAction('pane-close')}>
        Close Pane
        <KeyLabel keybindings={keybindings} op={TmuxOp.KillPane({ paneId: null })} />
      </MenuItem>
    </>
  );
}
