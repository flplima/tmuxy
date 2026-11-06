/**
 * A menu spec walked as pages, the way a phone app shows a menu: the top
 * level is the first page, and choosing a submenu goes to a page listing its
 * children (components/PhoneMenu.tsx). The way down is a path of submenu ids;
 * the spec is rebuilt from the live state, so a step that no longer leads
 * anywhere (a submenu gone or disabled) ends the walk there.
 *
 * Pure.
 */

import type { MenuNode, MenuSpec } from './spec';

export interface MenuPage {
  /** The submenu's label; null for the top page. */
  title: string | null;
  /** The submenu's id; null for the top page. */
  id: string | null;
  nodes: MenuSpec;
}

type Submenu = Extract<MenuNode, { kind: 'submenu' }>;

function submenuIn(nodes: MenuSpec, id: string): Submenu | null {
  for (const node of nodes) {
    if (node.kind === 'submenu' && node.id === id && !node.disabled) return node;
  }
  return null;
}

/** The pages from the top down `path`, as far as it still leads. */
export function menuPages(spec: MenuSpec, path: readonly string[]): MenuPage[] {
  const pages: MenuPage[] = [{ title: null, id: null, nodes: spec }];
  for (const id of path) {
    const sub = submenuIn(pages[pages.length - 1].nodes, id);
    if (!sub) break;
    pages.push({ title: sub.label, id: sub.id, nodes: sub.children });
  }
  return pages;
}
