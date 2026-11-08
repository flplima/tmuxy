/**
 * The phone walks the app menu as pages: the top level, then a page per
 * submenu chosen. The spec is rebuilt from the live state, so a path can
 * outlive the submenu it names.
 */

import { describe, it, expect } from 'vitest';
import { menuPages } from '../menuPages';
import type { MenuSpec } from '../spec';

// The action is opaque to the walk: a string stands in for the app's.
const spec: MenuSpec<string> = [
  {
    kind: 'submenu',
    id: 'menu-view',
    label: 'View',
    children: [
      { kind: 'item', id: 'zoom', label: 'Zoom', action: 'zoom' },
      {
        kind: 'submenu',
        id: 'menu-theme',
        label: 'Theme',
        children: [{ kind: 'item', id: 'dracula', label: 'Dracula', action: 't' }],
      },
    ],
  },
  { kind: 'submenu', id: 'menu-off', label: 'Off', disabled: true, children: [] },
  { kind: 'item', id: 'about', label: 'About', action: 'about' },
];

describe('menuPages', () => {
  it('is the top page alone with no path', () => {
    const pages = menuPages(spec, []);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ title: null, id: null });
    expect(pages[0].nodes).toBe(spec);
  });

  it('walks down a page per submenu, titled with its label', () => {
    const pages = menuPages(spec, ['menu-view', 'menu-theme']);
    expect(pages.map((p) => p.title)).toEqual([null, 'View', 'Theme']);
    expect(pages[2].nodes.map((n) => (n.kind === 'item' ? n.id : n.kind))).toEqual(['dracula']);
  });

  it('stops where the path no longer leads: a submenu gone, or disabled', () => {
    expect(menuPages(spec, ['menu-view', 'gone', 'menu-theme']).map((p) => p.id)).toEqual([
      null,
      'menu-view',
    ]);
    expect(menuPages(spec, ['menu-off'])).toHaveLength(1);
    expect(menuPages(spec, ['about'])).toHaveLength(1);
  });
});
