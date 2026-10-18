/**
 * The menu specs per state: what each surface offers, enabled or not, and
 * that every item dispatches one of the three action kinds. The renderers
 * (in-app, native popup, native bar) draw these as they are, so a menu that
 * is wrong is wrong here first.
 */

import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../machines/app/context';
import { pid, wid } from '../../../test/wire';
import type { AppMachineContext } from '../../../machines/types/context';
import type { TmuxPane, TmuxWindow } from '../../client';
import { appMenuSpec, appItemsSpec, debugMenuSpec, themeMenuSpec } from '../appMenu';
import { paneMenuSpec } from '../paneMenu';
import { tabMenuSpec } from '../tabMenu';
import { selectionMenuSpec } from '../selectionMenu';
import { sessionSwitcherSpec } from '../sessionSwitcher';
import { windowMenuSpec } from '../windowMenu';
import { itemIds, tidy, type MenuEnv, type MenuNode, type MenuSpec } from '../spec';

const WEB: MenuEnv = { readOnly: false, isDemo: false, isTauri: false, isMac: false };
const MAC: MenuEnv = { ...WEB, isTauri: true, isMac: true };
const LINUX: MenuEnv = { ...WEB, isTauri: true };
const VIEWER: MenuEnv = { ...WEB, readOnly: true };

function pane(id: string, windowId: string, marked = false): TmuxPane {
  return {
    tmuxId: pid(id),
    windowId: wid(windowId),
    x: 0,
    y: 0,
    width: 80,
    height: 24,
    active: true,
    marked,
  } as unknown as TmuxPane;
}

function win(id: string, collapsible = false): TmuxWindow {
  return {
    id: wid(id),
    index: Number(id.slice(1)),
    name: `w${id}`,
    active: id === '@1',
    windowType: 'tab',
    collapsible,
  } as unknown as TmuxWindow;
}

function ctx(overrides: Partial<AppMachineContext> = {}): AppMachineContext {
  return {
    ...createInitialContext(),
    activeWindowId: wid('@1'),
    activePaneId: pid('%1'),
    windows: [win('@1'), win('@2')],
    panes: [pane('%1', '@1'), pane('%2', '@1'), pane('%3', '@2')],
    ...overrides,
  };
}

const find = (spec: MenuSpec, id: string): MenuNode | undefined => {
  for (const node of spec) {
    if ('id' in node && node.id === id) return node;
    if (node.kind === 'submenu') {
      const inner = find(node.children, id);
      if (inner) return inner;
    }
  }
  return undefined;
};
const disabled = (spec: MenuSpec, id: string) => {
  const node = find(spec, id);
  return node && 'disabled' in node ? Boolean(node.disabled) : undefined;
};

describe('tidy', () => {
  it('drops the separators that would open, close or double up a list', () => {
    const sep: MenuNode = { kind: 'separator' };
    const a: MenuNode = { kind: 'header', label: 'a' };
    expect(tidy([sep, a, sep, sep, false, a, sep])).toEqual([a, sep, a]);
  });
});

describe('paneMenuSpec', () => {
  it('a context menu is about its pane: no navigation, marked items by state', () => {
    const spec = paneMenuSpec(ctx(), { paneId: pid('%1'), navigation: false, rename: true });
    const ids = itemIds(spec);
    expect(ids).not.toContain('pane-next');
    expect(ids).not.toContain('pane-swap-prev');
    expect(ids[0]).toBe('pane-rename');
    expect(ids).toContain('pane-mark');
    expect(ids).not.toContain('pane-unmark');
    expect(disabled(spec, 'pane-swap-marked')).toBe(true);
    expect(ids[ids.length - 1]).toBe('pane-close');
  });

  it('the app menu has navigation, disabled on a single pane, and Unmark on the marked pane', () => {
    const single = ctx({ panes: [pane('%1', '@1', true)] });
    const spec = paneMenuSpec(single, { paneId: null });
    expect(disabled(spec, 'pane-next')).toBe(true);
    expect(disabled(spec, 'pane-swap-next')).toBe(true);
    expect(itemIds(spec)).toContain('pane-unmark');
    expect(disabled(spec, 'pane-swap-marked')).toBe(true);
    const two = paneMenuSpec(ctx(), { paneId: null });
    expect(disabled(two, 'pane-next')).toBe(false);
  });

  it("a widget's items come first, with the attribute tests click by", () => {
    const spec = paneMenuSpec(ctx(), {
      paneId: pid('%1'),
      widgetItems: [{ id: 'reload', label: 'Reload', event: { type: 'TOGGLE_TAB_OVERVIEW' } }],
    });
    const first = spec[0];
    expect(first.kind).toBe('item');
    if (first.kind === 'item') {
      expect(first.data).toEqual({ 'widget-action': 'reload' });
      expect(first.action).toEqual({ kind: 'event', event: { type: 'TOGGLE_TAB_OVERVIEW' } });
    }
  });
});

describe('tabMenuSpec', () => {
  it('a context menu leaves navigation out and acts on its own tab', () => {
    const spec = tabMenuSpec(ctx(), WEB, { windowId: wid('@2'), navigation: false });
    const ids = itemIds(spec);
    expect(ids).not.toContain('tab-next');
    expect(ids).toEqual(['tab-new', 'tab-overview', 'tab-stack-toggle', 'tab-rename', 'tab-close']);
    const close = find(spec, 'tab-close');
    expect(close && 'action' in close && close.action.kind).toBe('event');
  });

  it('the app menu disables navigation on a single tab and reads Stacked Panes off the active tab', () => {
    const spec = tabMenuSpec(ctx({ windows: [win('@1', true)] }), WEB, { windowId: null });
    expect(disabled(spec, 'tab-next')).toBe(true);
    const stacked = find(spec, 'tab-stack-toggle');
    expect(stacked?.kind).toBe('checkbox');
    if (stacked?.kind === 'checkbox') expect(stacked.checked).toBe(true);
  });

  it('a viewer gets nothing that changes the session', () => {
    expect(itemIds(tabMenuSpec(ctx(), VIEWER, { windowId: null }))).toEqual([
      'tab-overview',
      'tab-next',
      'tab-previous',
      'tab-last',
    ]);
  });
});

describe('appMenuSpec', () => {
  it('offers the submenus by host and ends with the app items', () => {
    const web = appMenuSpec(ctx(), WEB);
    const submenus = web
      .filter((n) => n.kind === 'submenu')
      .map((n) => n.kind === 'submenu' && n.label);
    expect(submenus).toEqual(['Pane', 'Tab', 'Session', 'Theme', 'View', 'Debug', 'Help']);
    const ids = itemIds(web);
    expect(ids).toContain('session-reload-config');
    expect(ids).not.toContain('restart-app');
    expect(ids).not.toContain('quit');
    expect(ids).toContain('help-about');
    expect(ids).not.toContain('help-reveal-log-file');

    const linux = itemIds(appMenuSpec(ctx(), LINUX));
    expect(linux.slice(-3)).toEqual(['session-reload-config', 'restart-app', 'quit']);
    expect(linux).toContain('help-reveal-log-file');

    const mac = itemIds(appMenuSpec(ctx(), MAC));
    expect(mac).not.toContain('quit');
  });

  it('a viewer or the demo sees only what it can do', () => {
    const viewer = appMenuSpec(ctx(), VIEWER);
    expect(
      viewer.filter((n) => n.kind === 'submenu').map((n) => n.kind === 'submenu' && n.label),
    ).toEqual(['Tab', 'Theme', 'View', 'Help']);
    expect(itemIds(viewer)).not.toContain('session-reload-config');
    const demo = appMenuSpec(ctx(), { ...WEB, isDemo: true });
    expect(disabled(demo, 'session-kill')).toBe(true);
    expect(itemIds(demo)).not.toContain('session-reload-config');
  });

  it('the macOS app section is About, the app items, then the platform items', () => {
    const bar = appItemsSpec(MAC, 'native-bar');
    expect(
      bar.map((n) => (n.kind === 'predefined' ? n.which : n.kind === 'item' ? n.id : n.kind)),
    ).toEqual([
      'about',
      'separator',
      'session-reload-config',
      'restart-app',
      'separator',
      'hide',
      'hide-others',
      'show-all',
      'separator',
      'quit',
    ]);
  });
});

describe('themeMenuSpec and debugMenuSpec', () => {
  it('marks the current theme and mode, and greys out a mode the theme has no palette for', () => {
    const spec = themeMenuSpec(
      ctx({
        themeName: 'mine',
        themeMode: 'dark',
        availableThemes: [
          { name: 'default', displayName: 'Default', modes: ['dark', 'light'] },
          { name: 'mine', displayName: 'Mine', modes: ['dark'] },
        ],
      }),
    );
    const checked = (id: string) => {
      const node = find(spec, id);
      return node?.kind === 'checkbox' ? node.checked : undefined;
    };
    expect(checked('theme-set-mine')).toBe(true);
    expect(checked('theme-set-default')).toBe(false);
    expect(checked('theme-mode-dark')).toBe(true);
    expect(disabled(spec, 'theme-mode-light')).toBe(true);
    expect(disabled(spec, 'theme-mode-auto')).toBe(true);
  });

  it('a locked trace switch is disabled and the levels wait for it', () => {
    const spec = debugMenuSpec(
      ctx({ traceSettings: { enabled: false, level: 'shape', path: null, locked: true } }),
      WEB,
    );
    expect(disabled(spec, 'trace-enabled')).toBe(true);
    const levels = find(spec, 'trace-level');
    expect(levels?.kind).toBe('radio-group');
    if (levels?.kind === 'radio-group') expect(levels.options.every((o) => o.disabled)).toBe(true);
    expect(itemIds(spec)).not.toContain('trace-open');
    expect(disabled(spec, 'trace-copy-path')).toBe(true);
  });
});

describe('selection, session switcher and window menus', () => {
  it('a viewer can copy but not type', () => {
    expect(itemIds(selectionMenuSpec(WEB))).toEqual(['selection-copy', 'selection-send-keys']);
    expect(itemIds(selectionMenuSpec(VIEWER))).toEqual(['selection-copy']);
  });

  it('lists sessions with the current one marked, restorable ones for a writer, servers on the desktop', () => {
    const c = ctx({
      sessionName: 'main',
      sessions: [{ sessionName: 'main' }, { sessionName: 'work' }] as AppMachineContext['sessions'],
      restorableSessions: [{ name: 'old' }] as AppMachineContext['restorableSessions'],
      servers: [
        { id: 'localhost', label: 'localhost' },
        { id: 'box', label: 'box' },
      ] as AppMachineContext['servers'],
      currentServerId: 'localhost',
    });
    const web = sessionSwitcherSpec(c, WEB);
    expect(itemIds(web)).toEqual(['session:main', 'session:work', 'restore:old']);
    expect(find(web, 'session:main')).toMatchObject({
      label: '● main',
      data: { 'session-name': 'main', current: 'true' },
    });
    expect(itemIds(sessionSwitcherSpec(c, VIEWER))).toEqual(['session:main', 'session:work']);
    expect(itemIds(sessionSwitcherSpec(c, MAC))).toEqual([
      'session:main',
      'session:work',
      'restore:old',
      'server:localhost',
      'server:box',
      'session-connect',
    ]);
  });

  it('the Window submenu lists the styles with the current one checked and the open windows', () => {
    const node = windowMenuSpec(MAC, {
      style: 'no-title-bar',
      windows: [{ index: 1, title: 'one', focused: true }],
    });
    const ids = itemIds([node]);
    expect(ids).toContain('window-style-no-title-bar');
    expect(ids).toContain('window-focus-1');
    const style = find([node], 'window-style-no-title-bar');
    if (style?.kind === 'checkbox') expect(style.checked).toBe(true);
    const close = find([node], 'window-close');
    if (close?.kind === 'item') expect(close.accelerator).toBe('CmdOrCtrl+Shift+W');
  });
});
