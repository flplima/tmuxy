/**
 * The installed plugins, as the client's menus know them.
 *
 * `tmuxy plugin install|update|remove` (and every server as it attaches)
 * writes the inventory into the global tmux option `@tmuxy-plugins`, base64
 * of a JSON array (`tmuxy_core::plugins::inventory`), and its revision into
 * `@tmuxy-plugins-rev`, which rides the state stream (`pluginsRev`). A new
 * revision has the machine read the option once (`FETCH_PLUGINS`) and parse
 * it here. Anything malformed is dropped rather than shown: a name reaches a
 * tmux command line (`TmuxOp.PluginAction`), so only the alphabet the server
 * accepts gets through.
 */

import { decodeBase64Text } from './base64';

/** Which menu offers an action. */
export type PluginMenu = 'app' | 'pane' | 'selection';

export interface PluginActionInfo {
  readonly id: string;
  readonly title: string;
  /** `null`: no menu offers it (`tmuxy plugin action` and keys still can). */
  readonly menu: PluginMenu | null;
  readonly surface: string;
}

export interface PluginInfo {
  readonly name: string;
  readonly actions: ReadonlyArray<PluginActionInfo>;
  /** Hosts its URL handlers take; the server checks the whole URL. */
  readonly linkHosts: ReadonlyArray<string>;
  /** Whether it has text handlers, which run on the server. */
  readonly textLinks: boolean;
}

/** The option the inventory is read from. */
export const PLUGINS_OPTION = '@tmuxy-plugins';

/** The query that reads it. */
export const READ_PLUGINS_COMMAND = `show-options -gqv ${PLUGINS_OPTION}`;

/** A plugin or action name, as the server validates one. */
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isPluginName(name: string): boolean {
  return NAME.test(name);
}

const MENUS: ReadonlySet<string> = new Set(['app', 'pane', 'selection']);

function asAction(raw: unknown): PluginActionInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !isPluginName(r.id)) return null;
  if (typeof r.title !== 'string' || r.title.trim() === '') return null;
  const menu = typeof r.menu === 'string' && MENUS.has(r.menu) ? (r.menu as PluginMenu) : null;
  return {
    id: r.id,
    title: r.title.slice(0, 80),
    menu,
    surface: typeof r.surface === 'string' ? r.surface : 'split',
  };
}

/** The inventory from the option's value; `[]` for anything unreadable. */
export function parseInventory(raw: string): PluginInfo[] {
  const value = raw.trim();
  if (value === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Text(value));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const plugins: PluginInfo[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || !isPluginName(e.name)) continue;
    const actions = Array.isArray(e.actions)
      ? e.actions.map(asAction).filter((a): a is PluginActionInfo => a !== null)
      : [];
    const linkHosts = Array.isArray(e.link_hosts)
      ? e.link_hosts.filter(
          (h): h is string => typeof h === 'string' && /^[a-z0-9.-]{1,253}$/.test(h),
        )
      : [];
    plugins.push({ name: e.name, actions, linkHosts, textLinks: e.text_links === true });
  }
  return plugins;
}

/** One menu entry: a plugin's action. */
export interface PluginMenuEntry {
  readonly plugin: string;
  readonly action: PluginActionInfo;
}

/** The actions a menu offers, in inventory order. */
export function pluginMenuEntries(
  plugins: ReadonlyArray<PluginInfo>,
  menu: PluginMenu,
): PluginMenuEntry[] {
  return plugins.flatMap((plugin) =>
    plugin.actions
      .filter((a) => a.menu === menu)
      .map((action) => ({ plugin: plugin.name, action })),
  );
}

/** A menu item's id for an action: what tests click by. */
export function pluginItemId(plugin: string, action: string): string {
  return `plugin:${plugin}:${action}`;
}

/** Every host a URL handler takes, and whether any plugin has text handlers. */
export function pluginLinkHosts(plugins: ReadonlyArray<PluginInfo>): {
  hosts: ReadonlySet<string>;
  text: boolean;
} {
  return {
    hosts: new Set(plugins.flatMap((p) => p.linkHosts)),
    text: plugins.some((p) => p.textLinks),
  };
}
