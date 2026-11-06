import { FloatingMenu } from './floating/Menu';
import { useAppSelector } from '../machines/appHooks';
import { tabMenuSpec } from './menus/specs/tabMenu';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
import type { WindowId } from '../domain/ids';
import { belowElement, useNativeMenu } from './menus/useNativeMenu';

interface TabContextMenuProps {
  windowId: WindowId;
  x: number;
  y: number;
  /** The tab's own element, when the menu is the preview card becoming the menu. */
  anchorEl?: HTMLElement | null;
  /** Where the preview card was, for the menu to grow out of. */
  morphFrom?: DOMRect | null;
  onClose: () => void;
  /** Start renaming this tab in the strip; the strip owns the field. */
  onRename: () => void;
}

export function TabContextMenu({
  windowId,
  x,
  y,
  anchorEl,
  morphFrom,
  onClose,
  onRename,
}: TabContextMenuProps) {
  const spec = useAppSelector((ctx) => tabMenuSpec(ctx, { windowId, navigation: false }));

  const dispatch = useMenuDispatch({
    onLocal: (local) => {
      if (local.verb === 'rename') onRename();
    },
  });

  const choose = (action: Parameters<typeof dispatch>[0]) => {
    dispatch(action);
    onClose();
  };
  // Natively the preview card just closes: a native menu grows out of nothing.
  const inApp = useNativeMenu(spec, choose, anchorEl ? belowElement(anchorEl) : { x, y }, onClose);
  if (!inApp) return null;

  return (
    <FloatingMenu
      // One floating surface at a time: this puts away the tab preview it replaces.
      id="tab-context-menu"
      label="Tab"
      // Grown out of a preview card, the menu belongs under the tab, not at the pointer.
      anchor={anchorEl ? { kind: 'element', element: anchorEl } : { kind: 'point', x, y }}
      placement={anchorEl ? { align: 'center' } : undefined}
      morphFrom={morphFrom}
      onClose={onClose}
    >
      {renderSpec(spec, choose)}
    </FloatingMenu>
  );
}
