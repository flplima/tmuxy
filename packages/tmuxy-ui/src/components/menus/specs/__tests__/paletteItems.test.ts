import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../../machines/app/context';
import type { AppMachineContext } from '../../../../machines/types/context';
import type { MenuEnv } from '../../../../domain/menus/spec';
import { viewMenuSpec } from '../appMenu';
import type { AppMenuSpec } from '../actions';

const WEB: MenuEnv = { isDemo: false, isTauri: false, isMac: false };
const MAC: MenuEnv = { ...WEB, isTauri: true, isMac: true };

const ctx = (overrides: Partial<AppMachineContext> = {}): AppMachineContext => ({
  ...createInitialContext(),
  ...overrides,
});

const find = (spec: AppMenuSpec, id: string) => spec.find((node) => 'id' in node && node.id === id);

describe('the View menu’s palette items', () => {
  it('lead the menu, ahead of Theme', () => {
    const ids = viewMenuSpec(ctx(), WEB).map((node) => ('id' in node ? node.id : node.kind));
    expect(ids.slice(0, 4)).toEqual(['view-palette', 'view-go-to', 'separator', 'menu-theme']);
  });

  it('the palette items name the keys that open it, the Mac its own modifier', () => {
    const keybindings = {
      prefix_key: 'C-a',
      repeat_time_ms: 300,
      prefix_bindings: [],
      root_bindings: [],
      tables: {},
    };
    const web = viewMenuSpec(ctx({ keybindings }), WEB);
    expect(find(web, 'view-palette')).toMatchObject({
      label: 'Command Palette…',
      keyHint: 'ctrl+shift+p',
    });
    expect(find(web, 'view-go-to')).toMatchObject({ keyHint: 'ctrl+a g' });
    expect(find(viewMenuSpec(ctx({ keybindings }), MAC), 'view-palette')).toMatchObject({
      keyHint: 'cmd+shift+p',
    });
    // A key the config bound is no longer the palette's to name.
    const bound = {
      ...keybindings,
      prefix_bindings: [{ key: 'g', command: 'display-message hi', description: '' }],
    };
    expect(find(viewMenuSpec(ctx({ keybindings: bound }), WEB), 'view-go-to')).toMatchObject({
      keyHint: undefined,
    });
  });
});
