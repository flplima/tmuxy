/**
 * One menu model for every menu surface, derived from the machine context.
 * Three renderers draw the same spec — the in-app floating menu
 * (`components/menus/SpecMenu.tsx`), the desktop's native popups and, on
 * macOS, the native menu bar (`infra/menus/nativeMenu.ts`).
 *
 * The vocabulary is generic over `A`, what choosing an item does: the
 * renderers only carry it to the dispatch, so they need not know the app's
 * events (the app's own is `AppMenuAction`, `components/menus/specs/actions.ts`).
 */

import type { MenuIconName } from './icons';

export type MenuDispatch<A> = (action: A) => void;

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

export type MenuNode<A> =
  | (ItemBase & {
      kind: 'item';
      action: A;
      icon?: MenuIconName;
    })
  | (ItemBase & { kind: 'checkbox'; checked: boolean; action: A })
  | {
      kind: 'radio-group';
      id: string;
      value: string;
      options: ReadonlyArray<{
        value: string;
        label: string;
        disabled?: boolean;
        action: A;
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
      onOpen?: A;
      children: MenuSpec<A>;
    }
  | { kind: 'predefined'; which: PredefinedItem };

export type MenuSpec<A> = ReadonlyArray<MenuNode<A>>;

export interface MenuEnv {
  isDemo: boolean;
  isTauri: boolean;
  isMac: boolean;
}

export const separator = { kind: 'separator' } as const;

/** Drop the separators that would open, close or double up a list. */
export function tidy<A>(
  nodes: ReadonlyArray<MenuNode<A> | false | null | undefined>,
): MenuNode<A>[] {
  const out: MenuNode<A>[] = [];
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
export function itemIds<A>(spec: MenuSpec<A>): string[] {
  const ids: string[] = [];
  for (const node of spec) {
    if (node.kind === 'item' || node.kind === 'checkbox') ids.push(node.id);
    else if (node.kind === 'radio-group')
      ids.push(...node.options.map((o) => `${node.id}:${o.value}`));
    else if (node.kind === 'submenu') ids.push(node.id, ...itemIds(node.children));
  }
  return ids;
}

/**
 * Every submenu's `onOpen`, nested ones included. A renderer that cannot
 * tell when a submenu opens (the native menu bar) runs them all ahead of
 * time instead, so the contents they read are there when it does.
 */
export function submenuOpeners<A>(spec: MenuSpec<A>): A[] {
  return spec.flatMap((node) =>
    node.kind === 'submenu'
      ? [...(node.onOpen ? [node.onOpen] : []), ...submenuOpeners(node.children)]
      : [],
  );
}
