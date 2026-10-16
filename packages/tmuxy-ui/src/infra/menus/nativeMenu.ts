/**
 * The desktop's native renderer for a menu spec (`domain/menus/spec.ts`):
 * a popup at a point for every context menu, and on macOS the application
 * menu bar — both built with `@tauri-apps/api/menu`, so the item callbacks
 * run here in the page and dispatch through the same `MenuDispatch` the
 * in-app menu uses. muda backs it with NSMenu on macOS and GTK on Linux.
 *
 * Every call can fail (no Tauri, a compositor without GTK menus, a refused
 * capability); the caller then draws the in-app menu in the same gesture.
 */

import type { MenuAction, MenuNode, MenuSpec, PredefinedItem } from '../../domain/menus/spec';
import type { MenuDispatch } from '../../components/menus/SpecMenu';
import type {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from '@tauri-apps/api/menu';

type MenuApi = typeof import('@tauri-apps/api/menu');
type NativeItem = CheckMenuItem | MenuItem | PredefinedMenuItem | Submenu;

const PREDEFINED: Record<
  PredefinedItem,
  | 'Copy'
  | 'Paste'
  | 'Hide'
  | 'HideOthers'
  | 'ShowAll'
  | 'Quit'
  | 'Minimize'
  | 'Maximize'
  | { About: null }
> = {
  about: { About: null },
  hide: 'Hide',
  'hide-others': 'HideOthers',
  'show-all': 'ShowAll',
  quit: 'Quit',
  copy: 'Copy',
  paste: 'Paste',
  minimize: 'Minimize',
  maximize: 'Maximize',
};

async function buildItems(
  api: MenuApi,
  spec: MenuSpec,
  dispatch: MenuDispatch,
): Promise<NativeItem[]> {
  const items: NativeItem[] = [];
  const run = (action: MenuAction) => () => dispatch(action);
  for (const node of spec) {
    items.push(await buildItem(api, node, run, dispatch));
  }
  return items;
}

async function buildItem(
  api: MenuApi,
  node: MenuNode,
  run: (action: MenuAction) => () => void,
  dispatch: MenuDispatch,
): Promise<NativeItem> {
  switch (node.kind) {
    case 'separator':
      return api.PredefinedMenuItem.new({ item: 'Separator' });
    case 'predefined':
      return api.PredefinedMenuItem.new({ item: PREDEFINED[node.which] });
    // A heading is an item nothing happens on.
    case 'header':
      return api.MenuItem.new({ text: node.label, enabled: false });
    case 'item':
      return api.MenuItem.new({
        id: node.id,
        text: node.external ? `${node.label}…` : node.label,
        enabled: !node.disabled,
        accelerator: node.accelerator,
        action: run(node.action),
      });
    case 'checkbox':
      return api.CheckMenuItem.new({
        id: node.id,
        text: node.label,
        checked: node.checked,
        enabled: !node.disabled,
        accelerator: node.accelerator,
        action: run(node.action),
      });
    // No native radio group: one check item per option, the chosen one ticked.
    case 'radio-group':
      return api.Submenu.new({
        id: node.id,
        text: '',
        items: await Promise.all(
          node.options.map((option) =>
            api.CheckMenuItem.new({
              id: `${node.id}:${option.value}`,
              text: option.label,
              checked: option.value === node.value,
              enabled: !option.disabled,
              action: run(option.action),
            }),
          ),
        ),
      });
    case 'submenu':
      return api.Submenu.new({
        id: node.id,
        text: node.label,
        enabled: !node.disabled,
        items: await buildItems(api, node.children, dispatch),
      });
  }
}

/**
 * A radio group is a flat run of check items in a native menu, not a
 * submenu: lift each group's options into the list that holds it.
 */
function flattenRadioGroups(spec: MenuSpec): MenuSpec {
  return spec.flatMap((node): MenuNode[] => {
    if (node.kind === 'radio-group') {
      return node.options.map((option) => ({
        kind: 'checkbox',
        id: `${node.id}:${option.value}`,
        label: option.label,
        checked: option.value === node.value,
        disabled: option.disabled,
        action: option.action,
      }));
    }
    if (node.kind === 'submenu') return [{ ...node, children: flattenRadioGroups(node.children) }];
    return [node];
  });
}

/**
 * Show the spec as a native popup at a page point. Resolves once the popup
 * has been shown — on macOS once it has closed again — and rejects where no
 * native popup is to be had, for the caller to fall back.
 */
export async function popupNativeMenu(
  spec: MenuSpec,
  dispatch: MenuDispatch,
  at: { x: number; y: number },
): Promise<void> {
  const api = await import('@tauri-apps/api/menu');
  const { LogicalPosition } = await import('@tauri-apps/api/dpi');
  const menu = await api.Menu.new({
    items: await buildItems(api, flattenRadioGroups(spec), dispatch),
  });
  try {
    await menu.popup(new LogicalPosition(at.x, at.y));
  } finally {
    // The items' callbacks have fired by now on macOS; elsewhere the menu
    // keeps them until it is closed.
    void menu.close().catch(() => {});
  }
}

let appMenu: Menu | null = null;

/**
 * Make the spec the application's menu bar (macOS). The previous one is
 * released once the new one is in place, so the bar never blinks empty.
 */
export async function setNativeAppMenu(spec: MenuSpec, dispatch: MenuDispatch): Promise<void> {
  const api = await import('@tauri-apps/api/menu');
  const menu = await api.Menu.new({
    items: await buildItems(api, flattenRadioGroups(spec), dispatch),
  });
  await menu.setAsAppMenu();
  const previous = appMenu;
  appMenu = menu;
  if (previous) void previous.close().catch(() => {});
}
