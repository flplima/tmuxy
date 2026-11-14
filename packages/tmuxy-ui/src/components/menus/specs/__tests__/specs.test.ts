import { describe, it, expect } from 'vitest';
import { createInitialContext } from '../../../../machines/app/context';
import { pid, wid } from '../../../../test/wire';
import type { AppMachineContext } from '../../../../machines/types/context';
import type { TmuxPane, TmuxWindow } from '../../../../domain/client';
import { appMenuSpec, appItemsSpec, debugMenuSpec, themeMenuSpec, viewMenuSpec } from '../appMenu';
import { paneMenuSpec } from '../paneMenu';
import { tabMenuSpec } from '../tabMenu';
import { selectionMenuSpec } from '../selectionMenu';
import { sessionSwitcherSpec } from '../sessionSwitcher';
import { windowMenuSpec } from '../windowMenu';
import { itemIds, tidy, type MenuEnv } from '../../../../domain/menus/spec';
import type { AppMenuNode as MenuNode, AppMenuSpec as MenuSpec } from '../actions';
import { TmuxOp } from '../../../../domain/commands';

const WEB: MenuEnv = { isDemo: false, isTauri: false, isMac: false };
const MAC: MenuEnv = { ...WEB, isTauri: true, isMac: true };
const LINUX: MenuEnv = { ...WEB, isTauri: true };

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

  it('Copy Mode is offered on a terminal and greyed out on a pane running a widget', () => {
    const preview = { ...pane('%2', '@1'), paneWidget: 'preview' };
    const withPreview = ctx({ panes: [pane('%1', '@1'), preview] });
    expect(disabled(paneMenuSpec(withPreview, { paneId: pid('%1') }), 'pane-copy-mode')).toBe(
      false,
    );
    expect(disabled(paneMenuSpec(withPreview, { paneId: pid('%2') }), 'pane-copy-mode')).toBe(true);
    const active = ctx({ panes: [pane('%1', '@1'), preview], activePaneId: pid('%2') });
    expect(disabled(paneMenuSpec(active, { paneId: null }), 'pane-copy-mode')).toBe(true);
  });

  it("a widget's items come first, with the attribute tests click by", () => {
    const spec = paneMenuSpec(ctx(), {
      paneId: pid('%1'),
      widgetItems: [
        {
          kind: 'item',
          id: 'widget:reload',
          label: 'Reload',
          data: { 'widget-action': 'reload' },
          action: { kind: 'event', event: { type: 'TOGGLE_TAB_OVERVIEW' } },
        },
      ],
    });
    const first = spec[0];
    expect(first.kind).toBe('item');
    if (first.kind === 'item') {
      expect(first.data).toEqual({ 'widget-action': 'reload' });
      expect(first.action).toEqual({ kind: 'event', event: { type: 'TOGGLE_TAB_OVERVIEW' } });
    }
  });
});

const PLUGINS: AppMachineContext['plugins'] = [
  {
    name: 'artifacts',
    actions: [
      { id: 'open', title: 'Open Artifact', menu: 'pane', surface: 'popup' },
      { id: 'home', title: 'Artifacts Home', menu: 'app', surface: 'tab' },
      { id: 'explain', title: 'Explain This', menu: 'selection', surface: 'float' },
      { id: 'hidden', title: 'No menu', menu: null, surface: 'split' },
    ],
    linkHosts: [],
    textLinks: false,
  },
  {
    name: 'devtools',
    actions: [{ id: 'inspect', title: 'Inspect', menu: 'pane', surface: 'split' }],
    linkHosts: [],
    textLinks: false,
  },
];

describe('the Plugins submenus', () => {
  it('are absent with no plugin offering an item', () => {
    expect(find(paneMenuSpec(ctx(), { paneId: pid('%2') }), 'pane-plugins')).toBeUndefined();
    expect(find(appMenuSpec(ctx(), WEB), 'app-plugins')).toBeUndefined();
  });

  it('the pane menu runs each pane action on its own pane, grouped by plugin', () => {
    const spec = paneMenuSpec(ctx({ plugins: PLUGINS }), { paneId: pid('%2') });
    const submenu = find(spec, 'pane-plugins');
    expect(submenu?.kind).toBe('submenu');
    if (submenu?.kind !== 'submenu') return;
    expect(
      submenu.children.map((n) => (n.kind === 'header' ? `# ${n.label}` : 'id' in n && n.id)),
    ).toEqual(['# artifacts', 'plugin:artifacts:open', '# devtools', 'plugin:devtools:inspect']);
    const item = find(submenu.children, 'plugin:artifacts:open');
    expect(item?.kind === 'item' && item.action).toEqual({
      kind: 'event',
      event: { type: 'PLUGIN_ACTION', plugin: 'artifacts', action: 'open', paneId: pid('%2') },
    });
  });

  it('an action a plugin key opens shows that key', () => {
    const keybindings = {
      prefix_key: 'C-a',
      repeat_time_ms: 300,
      prefix_bindings: [
        {
          key: 'M-o',
          command:
            'run-shell -b "\\"$TMUXY_DATA_DIR/bin/tmuxy-cli\\" plugin action artifacts:open --pane #{pane_id} --trigger key >/dev/null 2>&1"',
          description: '',
        },
      ],
      root_bindings: [],
      tables: {},
    };
    const spec = paneMenuSpec(ctx({ plugins: PLUGINS, keybindings }), { paneId: pid('%2') });
    const item = find(spec, 'plugin:artifacts:open');
    expect(item?.kind === 'item' && item.keyHint).toBeTruthy();
    const other = find(spec, 'plugin:devtools:inspect');
    expect(other?.kind === 'item' && other.keyHint).toBeFalsy();
  });

  it('the app menu offers the app actions, on the active pane', () => {
    const submenu = find(appMenuSpec(ctx({ plugins: PLUGINS }), WEB), 'app-plugins');
    if (submenu?.kind !== 'submenu') throw new Error('no Plugins submenu');
    expect(itemIds(submenu.children)).toEqual(['plugin:artifacts:home']);
    const item = submenu.children[0];
    expect(item.kind === 'item' && item.action).toEqual({
      kind: 'event',
      event: { type: 'PLUGIN_ACTION', plugin: 'artifacts', action: 'home', paneId: null },
    });
  });
});

describe('tabMenuSpec', () => {
  it('a context menu leaves navigation out and acts on its own tab', () => {
    const spec = tabMenuSpec(ctx(), { windowId: wid('@2'), navigation: false });
    const ids = itemIds(spec);
    expect(ids).not.toContain('tab-next');
    expect(ids).toEqual(['tab-new', 'tab-overview', 'tab-stack-toggle', 'tab-rename', 'tab-close']);
    const close = find(spec, 'tab-close');
    expect(close && 'action' in close && close.action).toEqual({
      kind: 'op',
      op: TmuxOp.KillWindow({ windowId: wid('@2') }),
    });
    // Stacked Panes flips this tab's option, not the active tab's.
    const stacked = find(spec, 'tab-stack-toggle');
    expect(stacked && 'action' in stacked && stacked.action).toEqual({
      kind: 'event',
      event: { type: 'TOGGLE_STACKED_PANES', windowId: wid('@2') },
    });
  });

  it('the app menu disables navigation on a single tab and reads Stacked Panes off the active tab', () => {
    const spec = tabMenuSpec(ctx({ windows: [win('@1', true)] }), { windowId: null });
    expect(disabled(spec, 'tab-next')).toBe(true);
    expect(find(spec, 'tab-stack-toggle')).toMatchObject({ kind: 'checkbox', checked: true });
  });
});

describe('appMenuSpec', () => {
  it('offers the submenus by host and ends with the app items', () => {
    const web = appMenuSpec(ctx(), WEB);
    const submenus = web
      .filter((n) => n.kind === 'submenu')
      .map((n) => n.kind === 'submenu' && n.label);
    expect(submenus).toEqual(['Pane', 'Tab', 'Session', 'View', 'Debug']);
    const view = web.find((n) => n.kind === 'submenu' && n.id === 'menu-view');
    const first = view?.kind === 'submenu' ? view.children.find((n) => n.kind === 'submenu') : null;
    expect(first).toMatchObject({ kind: 'submenu', id: 'menu-theme', label: 'Theme' });
    const ids = itemIds(web);
    expect(ids).toContain('session-reload-config');
    expect(ids).not.toContain('restart-app');
    expect(ids).not.toContain('quit');

    const linux = itemIds(appMenuSpec(ctx(), LINUX));
    expect(linux.slice(-3)).toEqual(['session-reload-config', 'restart-app', 'quit']);

    const mac = itemIds(appMenuSpec(ctx(), MAC));
    expect(mac).not.toContain('quit');
  });

  it('the demo sees only what it can do', () => {
    const demo = appMenuSpec(ctx(), { ...WEB, isDemo: true });
    expect(disabled(demo, 'session-kill')).toBe(true);
    expect(itemIds(demo)).not.toContain('session-reload-config');
    expect(itemIds(demo)).not.toContain('menu-debug');
  });

  it('Enable Window Transparency is the macOS desktop app’s, checked as the config says', () => {
    expect(find(appMenuSpec(ctx(), MAC), 'view-transparency')).toMatchObject({
      kind: 'checkbox',
      label: 'Enable Window Transparency',
      checked: true,
    });
    expect(find(appMenuSpec(ctx({ transparency: false }), MAC), 'view-transparency')).toMatchObject(
      { checked: false },
    );
    for (const env of [WEB, LINUX]) {
      expect(find(appMenuSpec(ctx(), env), 'view-transparency')).toBeUndefined();
    }
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

  // Config beats menu state: an option tmuxy.conf sets is the config's, so
  // every item for it is greyed out and the one in effect says where it is set.
  it('greys out what tmuxy.conf pins and says where it is set', () => {
    const themes = [
      { name: 'default', displayName: 'Default', modes: ['dark', 'light'] },
      { name: 'nord', displayName: 'Nord', modes: ['dark', 'light'] },
    ];
    const pinned = themeMenuSpec(
      ctx({
        themeName: 'nord',
        themeMode: 'dark',
        availableThemes: themes,
        pinnedOptions: ['@tmuxy-theme'],
      }),
    );
    expect(disabled(pinned, 'theme-set-nord')).toBe(true);
    expect(disabled(pinned, 'theme-set-default')).toBe(true);
    expect(find(pinned, 'theme-set-nord')).toMatchObject({ label: 'Nord (set in tmuxy.conf)' });
    expect(find(pinned, 'theme-set-default')).toMatchObject({ label: 'Default' });
    expect(disabled(pinned, 'theme-mode-light')).toBe(false);

    const view = viewMenuSpec(ctx({ pinnedOptions: ['@tmuxy-cursor-blink'] }), WEB);
    expect(disabled(view, 'view-cursor-blink')).toBe(true);
    expect(find(view, 'view-cursor-blink')).toMatchObject({
      label: 'Blinking Cursor (set in tmuxy.conf)',
    });
    expect(disabled(view, 'view-send-ask')).toBe(false);
  });

  // Notifications are a browser's (and the installed web app's): nowhere
  // else are they offered. tmuxy.conf turning them off greys the switch out
  // on every device and says so; a browser that blocked them says that.
  it('the notification switch follows the device, tmuxy.conf and the browser', () => {
    const view = (over: Partial<AppMachineContext>) => viewMenuSpec(ctx(over), WEB);
    expect(find(view({ pushState: 'unsupported' }), 'view-notify')).toBeUndefined();
    expect(
      find(viewMenuSpec(ctx({ pushState: 'off' }), { ...WEB, isDemo: true }), 'view-notify'),
    ).toBeUndefined();
    expect(find(view({ pushState: 'off' }), 'view-notify')).toMatchObject({
      label: 'Notify When a Pane Needs You',
      checked: false,
      disabled: false,
    });
    expect(find(view({ pushState: 'on' }), 'view-notify')).toMatchObject({ checked: true });
    expect(find(view({ pushState: 'on', notifyAllowed: false }), 'view-notify')).toMatchObject({
      label: 'Notify When a Pane Needs You (off in tmuxy.conf)',
      checked: false,
      disabled: true,
    });
    expect(find(view({ pushState: 'denied' }), 'view-notify')).toMatchObject({
      label: 'Notify When a Pane Needs You (blocked by the browser)',
      disabled: true,
    });
    expect(disabled(view({ pushState: 'working' }), 'view-notify')).toBe(true);
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
  it('copies and types the selection', () => {
    expect(itemIds(selectionMenuSpec())).toEqual(['selection-copy', 'selection-send-keys']);
  });

  it('hands the selection to a plugin’s selection actions, after the built-ins', () => {
    const spec = selectionMenuSpec(PLUGINS);
    expect(itemIds(spec)).toEqual([
      'selection-copy',
      'selection-send-keys',
      'plugin:artifacts:explain',
    ]);
    const item = find(spec, 'plugin:artifacts:explain');
    expect(item?.kind === 'item' && item.action).toEqual({
      kind: 'local',
      local: { verb: 'plugin-selection', plugin: 'artifacts', action: 'explain' },
    });
  });

  it('lists sessions with the current one marked, restorable ones, servers on the desktop', () => {
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

    expect(itemIds(sessionSwitcherSpec(c, MAC))).toEqual([
      'session:main',
      'session:work',
      'restore:old',
      'server:localhost',
      'server:box',
      'session-connect',
    ]);
  });

  it('a filter keeps the sessions and servers whose names contain it, ignoring case, and the connect item', () => {
    const c = ctx({
      sessionName: 'main',
      sessions: ['main', 'Work-API', 'work-web', 'notes'].map((sessionName) => ({
        sessionName,
      })) as AppMachineContext['sessions'],
      restorableSessions: [
        { name: 'old-work' },
        { name: 'scratch' },
      ] as AppMachineContext['restorableSessions'],
      servers: [
        { id: 'localhost', label: 'localhost' },
        { id: 'box', label: 'workbox' },
      ] as AppMachineContext['servers'],
      currentServerId: 'localhost',
    });
    expect(itemIds(sessionSwitcherSpec(c, MAC, ' WORK '))).toEqual([
      'session:Work-API',
      'session:work-web',
      'restore:old-work',
      'server:box',
      'session-connect',
    ]);
    const none = sessionSwitcherSpec(c, MAC, 'zzz');
    expect(itemIds(none)).toEqual(['session-connect']);
    expect(none.filter((node) => node.kind === 'header')).toEqual([]);
    expect(itemIds(sessionSwitcherSpec(c, WEB, ''))).toEqual(itemIds(sessionSwitcherSpec(c, WEB)));
  });

  it('the Window submenu lists the styles with the current one checked and the open windows', () => {
    const node = windowMenuSpec(MAC, {
      style: 'no-title-bar',
      windows: [{ index: 1, title: 'one', focused: true }],
    });
    const ids = itemIds([node]);
    expect(ids).toContain('window-style-no-title-bar');
    expect(ids).toContain('window-focus-1');
    expect(find([node], 'window-style-no-title-bar')).toMatchObject({
      kind: 'checkbox',
      checked: true,
    });
    expect(find([node], 'window-close')).toMatchObject({
      kind: 'item',
      accelerator: 'CmdOrCtrl+Shift+W',
    });
  });

  it('a window shortcut’s native accelerator is the key its hint names, off a Mac too', () => {
    const windows = [{ index: 2, title: 'two', focused: false }];
    const keys = (env: MenuEnv) =>
      ['window-new', 'window-focus-2'].map((id) => {
        const item = find([windowMenuSpec(env, { style: 'normal', windows })], id);
        return item && 'accelerator' in item ? [item.keyHint, item.accelerator] : null;
      });
    expect(keys(LINUX)).toEqual([
      ['ctrl+shift+n', 'Ctrl+Shift+N'],
      ['ctrl+shift+2', 'Ctrl+Shift+2'],
    ]);
    expect(keys(MAC)).toEqual([
      ['cmd+n', 'Cmd+N'],
      ['cmd+2', 'Cmd+2'],
    ]);
  });
});
