import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../../machines/app/context';
import { submenuOpeners, type MenuEnv } from '../../../../domain/menus/spec';
import type { AppMenuNode } from '../actions';
import { menuBarSpec } from '../menuBar';

const MAC: MenuEnv = { isDemo: false, isTauri: true, isMac: true };

describe('menuBarSpec', () => {
  it('has the hamburger’s submenus, with Edit and Window before Debug', () => {
    const windowMenu: AppMenuNode = {
      kind: 'submenu',
      id: 'menu-window',
      label: 'Window',
      children: [],
    };
    const bar = menuBarSpec(createInitialContext(), MAC, { windowMenu });
    expect(bar.map((n) => n.kind === 'submenu' && n.id)).toEqual([
      'menu-app',
      'menu-pane',
      'menu-tab',
      'menu-session',
      'menu-view',
      'menu-edit',
      'menu-window',
      'menu-debug',
    ]);
    // The Debug submenu reads the trace settings when it opens; the native bar
    // cannot tell, so it runs every opener up front.
    expect(submenuOpeners(bar)).toContainEqual({
      kind: 'event',
      event: { type: 'FETCH_TRACE_SETTINGS' },
    });
  });
});
