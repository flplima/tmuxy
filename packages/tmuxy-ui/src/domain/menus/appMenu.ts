/**
 * The application menu: the hamburger on the web and on Linux, the menu bar
 * on macOS. One spec; `placeAppItems` puts the app's own items where each
 * host's convention says.
 */

import type { AppMachineContext, TraceLevel } from '../../machines/types';
import type { WidgetMenuItem } from '../../components/widgets';
import { TmuxOp } from '../commands';
import type { ThemeInfo, ThemeMode } from '../../utils/themeManager';
import { paneMenuSpec } from './paneMenu';
import { tabMenuSpec } from './tabMenu';
import { keyHint } from './keyHint';
import { MENU_OPS } from '../../components/menus/menuActions';
import {
  action,
  event,
  local,
  separator,
  tidy,
  type MenuEnv,
  type MenuNode,
  type MenuSpec,
} from './spec';

export interface AppMenuOptions {
  /** The active pane's widget items, for the Pane submenu. */
  widgetItems?: ReadonlyArray<WidgetMenuItem>;
  /** The desktop's Window submenu, built by the surface from what it fetched. */
  windowMenu?: MenuNode;
}

/** The layouts tmux offers, in the order the menus list them. */
export const LAYOUTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'view-layout-even-horizontal', label: 'Even Horizontal' },
  { id: 'view-layout-even-vertical', label: 'Even Vertical' },
  { id: 'view-layout-main-horizontal', label: 'Main Horizontal' },
  { id: 'view-layout-main-vertical', label: 'Main Vertical' },
  { id: 'view-layout-tiled', label: 'Tiled' },
];

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
  // A theme whose file the server has not described (a list from an adapter
  // without the file) is taken to support both modes.
  const modes = themes.find((t) => t.name === name)?.modes;
  return modes === undefined || modes.includes(mode);
}

export function themeMenuSpec(ctx: AppMachineContext): MenuSpec {
  const { themeName, themeMode, availableThemes } = ctx;
  const has = (mode: 'dark' | 'light') => themeHasMode(availableThemes, themeName, mode);
  return tidy([
    // A mode the current theme declares no palette for is greyed out: picking
    // it would draw the page in the browser's defaults.
    ...MODES.map(
      ({ mode, label }): MenuNode => ({
        kind: 'checkbox',
        id: `theme-mode-${mode}`,
        label,
        checked: themeMode === mode,
        disabled: mode === 'auto' ? !has('dark') || !has('light') : !has(mode),
        action: event({ type: 'SET_THEME_MODE', mode }),
      }),
    ),
    separator,
    ...availableThemes.map(
      (t): MenuNode => ({
        kind: 'checkbox',
        id: `theme-set-${t.name}`,
        label: t.displayName,
        checked: themeName === t.name,
        action: event({ type: 'SET_THEME', name: t.name }),
      }),
    ),
  ]);
}

export function viewMenuSpec(ctx: AppMachineContext, env: MenuEnv): MenuSpec {
  return tidy([
    ...(env.readOnly
      ? []
      : LAYOUTS.map(
          (l): MenuNode => ({ kind: 'item', id: l.id, label: l.label, action: action(l.id) }),
        )),
    separator,
    {
      kind: 'item',
      id: 'view-font-bigger',
      label: 'Make Text Bigger',
      accelerator: 'CmdOrCtrl+=',
      action: event({ type: 'INCREASE_FONT_SIZE' }),
    },
    {
      kind: 'item',
      id: 'view-font-smaller',
      label: 'Make Text Smaller',
      accelerator: 'CmdOrCtrl+-',
      action: event({ type: 'DECREASE_FONT_SIZE' }),
    },
    {
      kind: 'item',
      id: 'view-font-reset',
      label: 'Make Text Normal Size',
      accelerator: 'CmdOrCtrl+0',
      action: event({ type: 'RESET_FONT_SIZE' }),
    },
    separator,
    // One switch for the machine, written back to the tmuxy config — not a
    // per-client preference like the theme.
    !env.readOnly && {
      kind: 'checkbox',
      id: 'view-cursor-blink',
      label: 'Blinking Cursor',
      checked: ctx.cursorBlink,
      action: event({ type: 'TOGGLE_CURSOR_BLINK' }),
    },
    !env.readOnly && {
      kind: 'checkbox',
      id: 'view-send-ask',
      label: 'Ask Before Sending Keys',
      checked: ctx.sendAsk,
      action: event({ type: 'TOGGLE_SEND_ASK' }),
    },
  ]);
}

/**
 * Debug — the local action trace and nothing else (docs/TELEMETRY.md). The
 * settings are read when the submenu opens rather than held: the backend is
 * the authority (a DO_NOT_TRACK kill switch can refuse an enable).
 */
export function debugMenuSpec(ctx: AppMachineContext, env: MenuEnv): MenuSpec {
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
      disabled: !trace?.enabled,
      action: event({ type: 'OPEN_TRACE_FILE' }),
    },
    {
      kind: 'item',
      id: 'trace-copy-path',
      label: 'Copy trace.ndjson Path',
      disabled: !trace?.enabled || !trace?.path,
      action: local('trace-copy-path'),
    },
    {
      kind: 'item',
      id: 'debug-copy-state',
      label: 'Copy App State',
      action: local('debug-copy-state'),
    },
  ]);
}

export function helpMenuSpec(env: MenuEnv): MenuSpec {
  return tidy([
    env.isTauri && {
      kind: 'item',
      id: 'help-reveal-log-file',
      label: 'Reveal Log File',
      action: local('help-reveal-log-file'),
    },
    env.isTauri && separator,
    {
      kind: 'item',
      id: 'help-github',
      label: 'Tmuxy on GitHub',
      external: true,
      action: action('help-github'),
    },
    {
      kind: 'item',
      id: 'help-report-bug',
      label: 'Report a Bug',
      external: true,
      action: action('help-report-bug'),
    },
    separator,
    { kind: 'item', id: 'help-about', label: 'About tmuxy', action: local('about') },
  ]);
}

/**
 * The app's own items — the ones about the app rather than about a pane,
 * tab or session. On macOS they are the `tmuxy` menu, in HIG order with the
 * predefined items around them; elsewhere they are the hamburger's last
 * section (Linux keeps Restart and Quit; a browser tab has neither).
 */
export function appItemsSpec(env: MenuEnv, placement: 'native-bar' | 'hamburger'): MenuSpec {
  const own: MenuNode[] = tidy([
    !env.readOnly &&
      !env.isDemo && {
        kind: 'item',
        id: 'session-reload-config',
        label: 'Reload Config',
        action: action('session-reload-config'),
      },
    env.isTauri && {
      kind: 'item',
      id: 'restart-app',
      label: 'Restart App',
      action: action('restart-app'),
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
        label: 'Quit',
        accelerator: 'Ctrl+Q',
        action: local('quit'),
      },
  ]);
}

export function sessionMenuSpec(ctx: AppMachineContext, env: MenuEnv): MenuSpec {
  const { keybindings } = ctx;
  return tidy([
    {
      kind: 'item',
      id: 'session-new',
      label: 'New Session',
      disabled: env.isDemo,
      action: action('session-new'),
    },
    {
      kind: 'item',
      id: 'session-rename',
      label: 'Rename Session',
      keyHint: keyHint(keybindings, MENU_OPS['session-rename']),
      disabled: env.isDemo,
      action: action('session-rename'),
    },
    {
      kind: 'item',
      id: 'session-detach',
      label: 'Detach Session',
      keyHint: keyHint(keybindings, TmuxOp.RawCommand({ command: 'detach-client' })),
      disabled: env.isDemo,
      action: action('session-detach'),
    },
    // Destructive and one click away: it asks first.
    {
      kind: 'item',
      id: 'session-kill',
      label: 'Kill Session…',
      disabled: env.isDemo,
      action: local('confirm-kill-session'),
    },
  ]);
}

/** The whole app menu, as the hamburger shows it; the menu bar takes its submenus. */
export function appMenuSpec(
  ctx: AppMachineContext,
  env: MenuEnv,
  options: AppMenuOptions = {},
): MenuSpec {
  return tidy([
    !env.readOnly && {
      kind: 'submenu',
      id: 'menu-pane',
      label: 'Pane',
      children: paneMenuSpec(ctx, { paneId: null, widgetItems: options.widgetItems }),
    },
    {
      kind: 'submenu',
      id: 'menu-tab',
      label: 'Tab',
      children: tabMenuSpec(ctx, env, { windowId: null }),
    },
    !env.readOnly && {
      kind: 'submenu',
      id: 'menu-session',
      label: 'Session',
      children: sessionMenuSpec(ctx, env),
    },
    options.windowMenu,
    { kind: 'submenu', id: 'menu-theme', label: 'Theme', children: themeMenuSpec(ctx) },
    { kind: 'submenu', id: 'menu-view', label: 'View', children: viewMenuSpec(ctx, env) },
    !env.readOnly && {
      kind: 'submenu',
      id: 'menu-debug',
      label: 'Debug',
      onOpen: event({ type: 'FETCH_TRACE_SETTINGS' }),
      children: debugMenuSpec(ctx, env),
    },
    { kind: 'submenu', id: 'menu-help', label: 'Help', children: helpMenuSpec(env) },
    separator,
    ...appItemsSpec(env, 'hamburger'),
  ]);
}
