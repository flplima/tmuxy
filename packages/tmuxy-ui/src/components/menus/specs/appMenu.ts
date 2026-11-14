/**
 * The application menu: the hamburger on the web and on Linux, the menu bar
 * on macOS. One spec; `placeAppItems` puts the app's own items where each
 * host's convention says.
 */

import type { AppMachineContext } from '../../../machines/types/context';
import type { TraceLevel, ThemeInfo, ThemeMode } from '../../../domain/wireSettings';
import { renameSessionPrompt, TmuxOp } from '../../../domain/commands';
import { PINNABLE, pinnedLabel } from '../../../domain/pins';
import { keyHint } from '../../../domain/keyLabels';
import type { MenuIconName } from '../../../domain/menus/icons';
import { separator, tidy, type MenuEnv } from '../../../domain/menus/spec';
import { paneMenuSpec } from './paneMenu';
import { tabMenuSpec } from './tabMenu';
import { pluginsSubmenu } from './pluginMenu';
import {
  command,
  commandHint,
  event,
  local,
  op,
  type AppMenuAction,
  type AppMenuNode,
  type AppMenuSpec,
} from './actions';

export interface AppMenuOptions {
  /** The active pane's widget items, for the Pane submenu. */
  widgetItems?: AppMenuSpec;
  /** The desktop's Window submenu, built by the surface from what it fetched. */
  windowMenu?: AppMenuNode;
}

const LAYOUTS: ReadonlyArray<{ layout: string; label: string; icon: MenuIconName }> = [
  { layout: 'even-horizontal', label: 'Even Horizontal', icon: 'layout-even-horizontal' },
  { layout: 'even-vertical', label: 'Even Vertical', icon: 'layout-even-vertical' },
  { layout: 'main-horizontal', label: 'Main Horizontal', icon: 'layout-main-horizontal' },
  { layout: 'main-vertical', label: 'Main Vertical', icon: 'layout-main-vertical' },
  { layout: 'tiled', label: 'Tiled', icon: 'layout-tiled' },
];

/** The items that open the palette; the palette leaves them out of its own list. */
export const PALETTE_ITEM_IDS = { all: 'view-palette', goTo: 'view-go-to' } as const;

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string }> = [
  { mode: 'dark', label: 'Dark Mode' },
  { mode: 'light', label: 'Light Mode' },
  { mode: 'auto', label: 'System' },
];

function themeHasMode(
  themes: ReadonlyArray<ThemeInfo>,
  name: string,
  mode: 'dark' | 'light',
): boolean {
  // A theme the list does not name (yet) is taken to support both modes.
  const modes = themes.find((t) => t.name === name)?.modes;
  return modes === undefined || modes.includes(mode);
}

export function themeMenuSpec(ctx: AppMachineContext): AppMenuSpec {
  const { themeName, themeMode, availableThemes, pinnedOptions } = ctx;
  const has = (mode: 'dark' | 'light') => themeHasMode(availableThemes, themeName, mode);
  // An option tmuxy.conf sets is the config's: every item for it is greyed
  // out, and the one in effect says where it is set.
  const modePinned = pinnedOptions.includes(PINNABLE.themeMode);
  const themePinned = pinnedOptions.includes(PINNABLE.theme);
  return tidy([
    // A mode the current theme declares no palette for is greyed out: picking
    // it would draw the page in the browser's defaults.
    ...MODES.map(
      ({ mode, label }): AppMenuNode => ({
        kind: 'checkbox',
        id: `theme-mode-${mode}`,
        label: pinnedLabel(label, modePinned && themeMode === mode),
        checked: themeMode === mode,
        disabled: modePinned || (mode === 'auto' ? !has('dark') || !has('light') : !has(mode)),
        action: event({ type: 'SET_THEME_MODE', mode }),
      }),
    ),
    separator,
    ...availableThemes.map(
      (t): AppMenuNode => ({
        kind: 'checkbox',
        id: `theme-set-${t.name}`,
        label: pinnedLabel(t.displayName, themePinned && themeName === t.name),
        checked: themeName === t.name,
        disabled: themePinned,
        action: event({ type: 'SET_THEME', name: t.name }),
      }),
    ),
  ]);
}

export function viewMenuSpec(ctx: AppMachineContext, env: MenuEnv): AppMenuSpec {
  return tidy([
    // Both search what the menus hold (components/palette): the first lists
    // everything, the second only the sessions, tabs and panes to go to.
    {
      kind: 'item',
      id: PALETTE_ITEM_IDS.all,
      label: 'Command Palette…',
      icon: 'search',
      // The chord is the Mac's own modifier there; Ctrl+Shift+P works too.
      keyHint: env.isMac ? 'cmd+shift+p' : commandHint(ctx.keybindings, 'palette'),
      action: command('palette'),
    },
    {
      kind: 'item',
      id: PALETTE_ITEM_IDS.goTo,
      label: 'Go to Session, Tab or Pane…',
      icon: 'go-to',
      keyHint: commandHint(ctx.keybindings, 'palette-go-to'),
      action: command('palette-go-to'),
    },
    separator,
    { kind: 'submenu', id: 'menu-theme', label: 'Theme', children: themeMenuSpec(ctx) },
    separator,
    {
      kind: 'item',
      id: 'view-activity',
      label: 'Activity',
      icon: 'tabs',
      keyHint: commandHint(ctx.keybindings, 'view-activity'),
      action: command('view-activity'),
    },
    {
      kind: 'item',
      id: 'view-activity-most-urgent',
      label: 'Go to the Pane That Needs You',
      icon: 'next',
      keyHint: commandHint(ctx.keybindings, 'view-activity-most-urgent'),
      action: command('view-activity-most-urgent'),
    },
    separator,
    ...LAYOUTS.map((l): AppMenuNode => {
      const layout = TmuxOp.SelectLayout({ layout: l.layout });
      return {
        kind: 'item',
        id: `view-layout-${l.layout}`,
        label: l.label,
        icon: l.icon,
        keyHint: keyHint(ctx.keybindings, layout),
        action: op(layout),
      };
    }),
    separator,
    {
      kind: 'item',
      id: 'view-font-bigger',
      label: 'Make Text Bigger',
      icon: 'text-bigger',
      accelerator: 'CmdOrCtrl+=',
      action: event({ type: 'INCREASE_FONT_SIZE' }),
    },
    {
      kind: 'item',
      id: 'view-font-smaller',
      label: 'Make Text Smaller',
      icon: 'text-smaller',
      accelerator: 'CmdOrCtrl+-',
      action: event({ type: 'DECREASE_FONT_SIZE' }),
    },
    {
      kind: 'item',
      id: 'view-font-reset',
      label: 'Make Text Normal Size',
      icon: 'text-normal',
      accelerator: 'CmdOrCtrl+0',
      action: event({ type: 'RESET_FONT_SIZE' }),
    },
    separator,
    // One switch for the machine, remembered in tmuxy.state.json — not a
    // per-client preference like the theme — unless tmuxy.conf pins it.
    {
      kind: 'checkbox',
      id: 'view-cursor-blink',
      label: pinnedLabel('Blinking Cursor', ctx.pinnedOptions.includes(PINNABLE.cursorBlink)),
      checked: ctx.cursorBlink,
      disabled: ctx.pinnedOptions.includes(PINNABLE.cursorBlink),
      action: event({ type: 'TOGGLE_CURSOR_BLINK' }),
    },
    {
      kind: 'checkbox',
      id: 'view-send-ask',
      label: pinnedLabel('Ask Before Sending Keys', ctx.pinnedOptions.includes(PINNABLE.sendAsk)),
      checked: ctx.sendAsk,
      disabled: ctx.pinnedOptions.includes(PINNABLE.sendAsk),
      action: event({ type: 'TOGGLE_SEND_ASK' }),
    },
    // This device's push notifications (infra/pushNotifications.ts): off for
    // every device with `@tmuxy-notify off`, and the demo has no server to push from.
    !env.isDemo &&
      ctx.pushState !== 'unsupported' && {
        kind: 'checkbox',
        id: 'view-notify',
        label: !ctx.notifyAllowed
          ? 'Notify When a Pane Needs You (off in tmuxy.conf)'
          : ctx.pushState === 'denied'
            ? 'Notify When a Pane Needs You (blocked by the browser)'
            : 'Notify When a Pane Needs You',
        checked: ctx.notifyAllowed && ctx.pushState === 'on',
        disabled: !ctx.notifyAllowed || ctx.pushState === 'denied' || ctx.pushState === 'working',
        action: event({ type: 'TOGGLE_PUSH' }),
      },
    // The native blur only exists on macOS, and only the desktop app has a
    // window to make see-through.
    env.isTauri &&
      env.isMac && {
        kind: 'checkbox',
        id: 'view-transparency',
        label: pinnedLabel(
          'Enable Window Transparency',
          ctx.pinnedOptions.includes(PINNABLE.transparency),
        ),
        checked: ctx.transparency,
        disabled: ctx.pinnedOptions.includes(PINNABLE.transparency),
        action: event({ type: 'TOGGLE_TRANSPARENCY' }),
      },
  ]);
}

/**
 * Debug — the local action trace and nothing else (docs/TRACING.md). The
 * settings are read when the submenu opens rather than held: the backend is
 * the authority (a DO_NOT_TRACK kill switch can refuse an enable).
 */
export function debugMenuSpec(ctx: AppMachineContext, env: MenuEnv): AppMenuSpec {
  const trace = ctx.traceSettings;
  const levels: ReadonlyArray<{ value: TraceLevel; label: string }> = [
    { value: 'shape', label: 'Shape' },
    { value: 'labeled', label: 'Labeled' },
    { value: 'full', label: 'Full' },
  ];
  return tidy([
    {
      kind: 'checkbox',
      id: 'trace-enabled',
      label: 'Enable Traces',
      checked: trace?.enabled ?? false,
      disabled: trace?.locked ?? false,
      action: event({ type: 'SET_TRACE_ENABLED', enabled: !(trace?.enabled ?? false) }),
    },
    separator,
    { kind: 'header', label: 'Trace Level' },
    {
      kind: 'radio-group',
      id: 'trace-level',
      value: trace?.level ?? 'shape',
      options: levels.map((l) => ({
        value: l.value,
        label: l.label,
        disabled: !trace?.enabled,
        action: event({ type: 'SET_TRACE_LEVEL', level: l.value }),
      })),
    },
    separator,
    // The trace file lives on the machine running the backend, so only the
    // desktop app can open it — a browser tab cannot.
    env.isTauri && {
      kind: 'item',
      id: 'trace-open',
      label: 'Open trace.ndjson',
      icon: 'file',
      disabled: !trace?.enabled,
      action: event({ type: 'OPEN_TRACE_FILE' }),
    },
    {
      kind: 'item',
      id: 'trace-copy-path',
      label: 'Copy trace.ndjson Path',
      icon: 'copy',
      disabled: !trace?.enabled || !trace?.path,
      action: local({ verb: 'copy-trace-path' }),
    },
    {
      kind: 'item',
      id: 'debug-copy-report',
      label: 'Copy Bug Report Snippet',
      icon: 'copy',
      action: local({ verb: 'copy-bug-report' }),
    },
    {
      kind: 'item',
      id: 'debug-copy-state',
      label: 'Copy App State',
      icon: 'copy',
      action: local({ verb: 'copy-app-state' }),
    },
  ]);
}

/**
 * The app's own items — the ones about the app rather than about a pane,
 * tab or session. On macOS they are the `tmuxy` menu, in HIG order with the
 * predefined items around them; elsewhere they are the hamburger's last
 * section (Linux keeps Restart and Quit; a browser tab has neither).
 */
export function appItemsSpec(env: MenuEnv, placement: 'native-bar' | 'hamburger'): AppMenuSpec {
  const own: AppMenuNode[] = tidy<AppMenuAction>([
    !env.isDemo && {
      kind: 'item',
      id: 'session-reload-config',
      label: 'Reload Config',
      icon: 'reload',
      // tmuxy's own config, NOT ~/.tmux.conf — sourcing the user's vanilla
      // tmux config would drag their default-server bindings/options into the
      // isolated tmuxy socket.
      action: op(TmuxOp.SourceConfig()),
    },
    env.isTauri && {
      kind: 'item',
      id: 'restart-app',
      destructive: true,
      label: 'Restart App',
      icon: 'restart',
      action: command('restart-app'),
    },
  ]);
  if (placement === 'native-bar') {
    return tidy([
      { kind: 'predefined', which: 'about' },
      separator,
      ...own,
      separator,
      { kind: 'predefined', which: 'hide' },
      { kind: 'predefined', which: 'hide-others' },
      { kind: 'predefined', which: 'show-all' },
      separator,
      { kind: 'predefined', which: 'quit' },
    ]);
  }
  return tidy([
    ...own,
    env.isTauri &&
      !env.isMac && {
        kind: 'item',
        id: 'quit',
        destructive: true,
        label: 'Quit',
        icon: 'quit',
        accelerator: 'Ctrl+Q',
        action: local({ verb: 'quit' }),
      },
  ]);
}

export function sessionMenuSpec(ctx: AppMachineContext, env: MenuEnv): AppMenuSpec {
  const { keybindings } = ctx;
  const rename = renameSessionPrompt();
  return tidy([
    {
      kind: 'item',
      id: 'session-new',
      label: 'New Session',
      icon: 'new',
      disabled: env.isDemo,
      action: command('session-new'),
    },
    {
      kind: 'item',
      id: 'session-rename',
      label: 'Rename Session',
      icon: 'rename',
      keyHint: keyHint(keybindings, rename),
      disabled: env.isDemo,
      action: op(rename),
    },
    {
      kind: 'item',
      id: 'session-detach',
      destructive: true,
      label: 'Detach Session',
      icon: 'detach',
      keyHint: commandHint(keybindings, 'session-detach'),
      // Only the desktop detaches; the web server answers `unavailable`.
      disabled: env.isDemo || !env.isTauri,
      action: command('session-detach'),
    },
    {
      kind: 'item',
      id: 'session-kill',
      label: 'Kill Session…',
      icon: 'trash',
      disabled: env.isDemo,
      action: local({ verb: 'confirm-kill-session' }),
    },
  ]);
}

/** The whole app menu, as the hamburger shows it; the menu bar takes its submenus. */
export function appMenuSpec(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: AppMenuOptions = {},
): AppMenuSpec {
  return tidy<AppMenuAction>([
    {
      kind: 'submenu',
      id: 'menu-pane',
      label: 'Pane',
      children: paneMenuSpec(ctx, { paneId: null, widgetItems: options.widgetItems }),
    },
    {
      kind: 'submenu',
      id: 'menu-tab',
      label: 'Tab',
      children: tabMenuSpec(ctx, { windowId: null }),
    },
    {
      kind: 'submenu',
      id: 'menu-session',
      label: 'Session',
      children: sessionMenuSpec(ctx, env),
    },
    options.windowMenu,
    { kind: 'submenu', id: 'menu-view', label: 'View', children: viewMenuSpec(ctx, env) },
    pluginsSubmenu(ctx.plugins, 'app', null, ctx.keybindings),
    // The trace is a developer's tool for their own machine; the demo's
    // visitors have nothing to trace it into.
    !env.isDemo && {
      kind: 'submenu',
      id: 'menu-debug',
      label: 'Debug',
      onOpen: event({ type: 'FETCH_TRACE_SETTINGS' }),
      children: debugMenuSpec(ctx, env),
    },
    separator,
    ...appItemsSpec(env, 'hamburger'),
  ]);
}
