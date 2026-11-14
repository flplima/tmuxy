/**
 * The command palette's rows. The actions are the menu specs walked flat
 * (`domain/menus/spec.ts`), so the palette offers what the menus offer, with
 * the same labels and key hints, and nothing is written down twice. The
 * places to go (sessions, tabs, panes) are built beside them by the app.
 */

import type { MenuIconName } from '../menus/icons';
import type { MenuNode, MenuSpec } from '../menus/spec';

export type PaletteKind = 'action' | 'session' | 'tab' | 'pane';

/** What the palette lists: everything, or only the places to go. */
export type PaletteMode = 'all' | 'go';

export interface PaletteEntry<A> {
  /** Stable across openings: what the recent list remembers. */
  id: string;
  kind: PaletteKind;
  label: string;
  /** Where it is from, dimmed beside the label: the menu path, the tab, the session. */
  detail?: string;
  /** Other words that should find it. */
  keywords?: string;
  keyHint?: string;
  icon?: MenuIconName;
  /** A checkbox or radio item's state; undefined for the rest. */
  checked?: boolean;
  /**
   * Enter has to be pressed twice to run it, and it is never offered as what
   * was run last: the row Enter is on is not always one the user aimed at.
   */
  confirm?: boolean;
  action: A;
}

const PATH_SEPARATOR = ' › ';

export interface SpecEntryOptions {
  /** Item ids left out: the ones that open the palette itself. */
  omit?: ReadonlySet<string>;
}

type Chosen<A> = Omit<PaletteEntry<A>, 'id' | 'kind' | 'detail'>;
type Choosable<A> = Extract<MenuNode<A>, { kind: 'item' | 'checkbox' | 'radio-group' }>;

/** What one node offers to choose, each with the item id it is known by. */
function choicesOf<A>(node: Choosable<A>): Array<[string, Chosen<A>]> {
  if (node.kind === 'radio-group') {
    return node.options
      .filter((option) => !option.disabled)
      .map((option) => [
        `${node.id}:${option.value}`,
        { label: option.label, checked: option.value === node.value, action: option.action },
      ]);
  }
  if (node.disabled) return [];
  const shared = {
    keyHint: node.keyHint,
    action: node.action,
    ...(node.destructive ? { confirm: true } : {}),
  };
  return node.kind === 'checkbox'
    ? [[node.id, { ...shared, label: node.label, checked: node.checked }]]
    : [[node.id, { ...shared, label: node.label.replace(/…$/, ''), icon: node.icon }]];
}

/**
 * Every item of `spec` a user could choose now, submenus included, each with
 * the path of submenu labels that leads to it. Disabled items are left out:
 * the palette runs what it lists. An item reachable twice (the same id under
 * two submenus) is listed once, where it comes first.
 */
export function specEntries<A>(
  spec: MenuSpec<A>,
  options: SpecEntryOptions = {},
): PaletteEntry<A>[] {
  const out: PaletteEntry<A>[] = [];
  const seen = new Set<string>(options.omit);
  const walk = (nodes: MenuSpec<A>, path: readonly string[]) => {
    // A header names the items under it (a plugin's name over its actions).
    let header: string | null = null;
    for (const node of nodes) {
      if (node.kind === 'separator') header = null;
      else if (node.kind === 'header') header = node.label;
      else if (node.kind === 'submenu') {
        if (!node.disabled) walk(node.children, [...path, node.label]);
      } else if (node.kind !== 'predefined') {
        const detail = [...path, ...(header ? [header] : [])].join(PATH_SEPARATOR) || undefined;
        for (const [itemId, entry] of choicesOf(node)) {
          if (seen.has(itemId)) continue;
          seen.add(itemId);
          out.push({ id: `action:${itemId}`, kind: 'action', detail, ...entry });
        }
      }
    }
  };
  walk(spec, []);
  return out;
}

/** What finds an entry beside its label: where it is from, and its other names. */
export function entryText(entry: Pick<PaletteEntry<unknown>, 'detail' | 'keywords'>): string {
  return [entry.detail, entry.keywords].filter(Boolean).join(' ');
}

/**
 * `entries` with the recently chosen ones first, most recent first. `recent`
 * holds entry ids; one that names nothing listed now is skipped, and so is
 * one that asks before it runs: the first row is what Enter runs untyped,
 * and "what was run last" must never make that Close Pane.
 */
export function recentFirst<E extends { id: string; confirm?: boolean }>(
  entries: readonly E[],
  recent: readonly string[],
): { recent: E[]; rest: E[] } {
  const byId = new Map(entries.filter((entry) => !entry.confirm).map((entry) => [entry.id, entry]));
  const first: E[] = [];
  for (const id of recent) {
    const entry = byId.get(id);
    if (entry && !first.includes(entry)) first.push(entry);
  }
  const taken = new Set(first);
  return { recent: first, rest: entries.filter((entry) => !taken.has(entry)) };
}

/** `recent` with `id` moved to the front, held to `limit` ids. */
export function rememberRecent(recent: readonly string[], id: string, limit = 5): string[] {
  return [id, ...recent.filter((other) => other !== id)].slice(0, limit);
}
