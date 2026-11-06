/**
 * A menu spec walked as pages, the way a phone app shows a menu: the top
 * level is the first page, and choosing a submenu goes to a page listing its
 * children (components/phone/PhoneMenu.tsx). The way down is a path of submenu ids;
 * the spec is rebuilt from the live state, so a step that no longer leads
 * anywhere (a submenu gone or disabled) ends the walk there.
 *
 * Pure.
 */

import type { MenuNode, MenuSpec } from './spec';

export interface MenuPage<A> {
  /** The submenu's label; null for the top page. */
  title: string | null;
  /** The submenu's id; null for the top page. */
  id: string | null;
  nodes: MenuSpec<A>;
}

type Submenu<A> = Extract<MenuNode<A>, { kind: 'submenu' }>;

function submenuIn<A>(nodes: MenuSpec<A>, id: string): Submenu<A> | null {
  for (const node of nodes) {
    if (node.kind === 'submenu' && node.id === id && !node.disabled) return node;
  }
  return null;
}

/** The pages from the top down `path`, as far as it still leads. */
export function menuPages<A>(spec: MenuSpec<A>, path: readonly string[]): MenuPage<A>[] {
  const pages: MenuPage<A>[] = [{ title: null, id: null, nodes: spec }];
  for (const id of path) {
    const sub = submenuIn(pages[pages.length - 1].nodes, id);
    if (!sub) break;
    pages.push({ title: sub.label, id: sub.id, nodes: sub.children });
  }
  return pages;
}
