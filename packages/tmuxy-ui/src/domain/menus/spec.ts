/**
 * One menu model for every menu surface.
 *
 * A menu is DATA: a list of nodes derived from the machine context, so an
 * item's `disabled` and `checked` are the live state and never a copy of it.
 * Three renderers draw the same spec — the in-app floating menu
 * (`components/menus/SpecMenu.tsx`), the desktop's native popups and, on
 * macOS, the native menu bar (`infra/menus/nativeMenu.ts`) — and every item
 * dispatches through one place, `runMenuAction`. The item lists used to be
 * written twice (JSX here, Rust in the desktop app) and drifted apart.
 */

import type { AppMachineEvent } from '../../machines/types/events';
import type { MenuIconName } from './icons';

/** What choosing an item does. */
export type MenuAction =
  /** A menu action id, dispatched through `executeMenuAction` (`components/menus/menuActions.ts`). */
  | { kind: 'action'; id: string }
  /** An event sent to the app machine as is. */
  | { kind: 'event'; event: AppMachineEvent }
  /** Something the surface showing the menu handles itself (a dialog, a native call). */
  | { kind: 'local'; id: string };

export const action = (id: string): MenuAction => ({ kind: 'action', id });
export const event = (event: AppMachineEvent): MenuAction => ({ kind: 'event', event });
export const local = (id: string): MenuAction => ({ kind: 'local', id });

/** The native items a platform draws itself; the in-app renderer leaves them out. */
export type PredefinedItem =
  | 'about'
  | 'hide'
  | 'hide-others'
  | 'show-all'
  | 'quit'
  | 'copy'
  | 'paste'
  | 'minimize'
  | 'maximize';

interface ItemBase {
  /** Stable id: the React key, what tests click by, and the native item's id. */
  id: string;
  label: string;
  disabled?: boolean;
  /** Right-aligned key hint (`ctrl+a x`), looked up from the live bindings. */
  keyHint?: string;
  /** A native accelerator (`CmdOrCtrl+T`); the in-app renderer shows `keyHint`. */
  accelerator?: string;
  /** Extra `data-*` attributes on the in-app item, for tests. */
  data?: Record<string, string>;
  className?: string;
  testId?: string;
}

export type MenuNode =
  | (ItemBase & {
      kind: 'item';
      action: MenuAction;
      /** Opens something outside the app; drawn with an ↗. */
      external?: boolean;
      icon?: MenuIconName;
    })
  | (ItemBase & { kind: 'checkbox'; checked: boolean; action: MenuAction })
  | {
      kind: 'radio-group';
      id: string;
      value: string;
      options: ReadonlyArray<{
        value: string;
        label: string;
        disabled?: boolean;
        action: MenuAction;
      }>;
    }
  | { kind: 'separator' }
  | { kind: 'header'; label: string }
  | {
      kind: 'submenu';
      id: string;
      label: string;
      disabled?: boolean;
      /** Dispatched when the submenu opens, for one whose contents are read on demand. */
      onOpen?: MenuAction;
      children: MenuSpec;
    }
  | { kind: 'predefined'; which: PredefinedItem };

export type MenuSpec = ReadonlyArray<MenuNode>;

/** Where a menu is shown; what each spec builder needs to know beyond the context. */
export interface MenuEnv {
  readOnly: boolean;
  isDemo: boolean;
  isTauri: boolean;
  isMac: boolean;
}

export const separator: MenuNode = { kind: 'separator' };

/** Drop the separators that would open, close or double up a list. */
export function tidy(nodes: ReadonlyArray<MenuNode | false | null | undefined>): MenuNode[] {
  const out: MenuNode[] = [];
  for (const node of nodes) {
    if (!node) continue;
    if (node.kind === 'separator') {
      if (out.length === 0 || out[out.length - 1].kind === 'separator') continue;
    }
    out.push(node);
  }
  while (out.length > 0 && out[out.length - 1].kind === 'separator') out.pop();
  return out;
}

/** Every item id in a spec, submenus included — what a test asserts a menu offers. */
export function itemIds(spec: MenuSpec): string[] {
  const ids: string[] = [];
  for (const node of spec) {
    if (node.kind === 'item' || node.kind === 'checkbox') ids.push(node.id);
    else if (node.kind === 'radio-group')
      ids.push(...node.options.map((o) => `${node.id}:${o.value}`));
    else if (node.kind === 'submenu') ids.push(node.id, ...itemIds(node.children));
  }
  return ids;
}
