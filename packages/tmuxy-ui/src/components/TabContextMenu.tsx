/**
 * TabContextMenu — the right-click menu of one tab: the tab spec without the
 * navigation items, about the tab it was opened on. Opened under the tab it
 * grew out of (the tab preview turns into it) or at the pointer.
 */

import { FloatingMenu } from './floating/Menu';
import { useAppSend, useAppSelector } from '../machines/AppContext';
import { tabMenuSpec } from '../domain/menus/tabMenu';
import { renderSpec, useMenuDispatch } from './menus/SpecMenu';
import { useMenuEnv } from './menus/menuEnv';
import { TmuxOp } from '../domain/commands';
import type { WindowId } from '../domain/ids';
import { belowElement, useNativeMenu } from './menus/useNativeMenu';

interface TabContextMenuProps {
  /** tmux window id the actions target (Close/Rename operate on this tab). */
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
  const send = useAppSend();
  const env = useMenuEnv();
  const spec = useAppSelector((ctx) => tabMenuSpec(ctx, env, { windowId, navigation: false }));
  const collapsible = useAppSelector((ctx) =>
    Boolean(ctx.windows.find((w) => w.id === windowId)?.collapsible),
  );

  const dispatch = useMenuDispatch({
    onLocal: (id) => {
      if (id === 'tab-rename') onRename();
      // Stacked panes: a window option the backend reads (docs/TMUX.md). On,
      // only the active pane's first-level row stays expanded; off evens the
      // rows back out.
      if (id === 'tab-stack-toggle') {
        send({
          type: 'DISPATCH_OP',
          op: TmuxOp.SetWindowTag({
            windowId,
            tag: 'collapsible',
            value: collapsible ? null : '1',
          }),
        });
      }
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
      // One floating surface at a time: opening this puts away the tab preview
      // it is replacing, and any other menu (components/floating).
      id="tab-context-menu"
      label="Tab"
      // Where the card was, when there was one: the menu is that card becoming
      // something else, so it belongs under the tab rather than at the pointer.
      anchor={anchorEl ? { kind: 'element', element: anchorEl } : { kind: 'point', x, y }}
      placement={anchorEl ? { align: 'center' } : undefined}
      morphFrom={morphFrom}
      onClose={onClose}
    >
      {renderSpec(spec, choose)}
    </FloatingMenu>
  );
}
