/**
 * The Plugins items: each installed plugin's actions for a menu
 * (`[[actions]] menu = "app" | "pane" | "selection"` in its manifest),
 * labelled with the action's title and, when more than one plugin offers
 * items, grouped under each plugin's name.
 */

import type { PaneId } from '../../../domain/ids';
import type { KeyBindings } from '../../../domain/wire';
import { pluginKeyHint } from '../../../domain/keyLabels';
import {
  pluginItemId,
  pluginMenuEntries,
  type PluginInfo,
  type PluginMenu,
} from '../../../domain/plugins';
import { event, local, type AppMenuNode, type AppMenuSpec } from './actions';

/**
 * The items for `menu`. App and pane items send PLUGIN_ACTION on `paneId`
 * (`null`: the active pane); selection items are `local` (the selection
 * menu sends the text with the action itself).
 */
export function pluginItems(
  plugins: ReadonlyArray<PluginInfo>,
  menu: PluginMenu,
  paneId: PaneId | null,
  keybindings: KeyBindings | null = null,
): AppMenuSpec {
  const entries = pluginMenuEntries(plugins, menu);
  const several = new Set(entries.map((e) => e.plugin)).size > 1;
  const nodes: AppMenuNode[] = [];
  let last: string | null = null;
  for (const { plugin, action } of entries) {
    if (several && plugin !== last) nodes.push({ kind: 'header', label: plugin });
    last = plugin;
    const id = pluginItemId(plugin, action.id);
    nodes.push({
      kind: 'item',
      id,
      label: action.title,
      keyHint: pluginKeyHint(keybindings, plugin, action.id),
      data: { 'plugin-action': `${plugin}:${action.id}` },
      action:
        menu === 'selection'
          ? local({ verb: 'plugin-selection', plugin, action: action.id })
          : event({ type: 'PLUGIN_ACTION', plugin, action: action.id, paneId }),
    });
  }
  return nodes;
}

/** The Plugins submenu of the app or pane menu; nothing when it would be empty. */
export function pluginsSubmenu(
  plugins: ReadonlyArray<PluginInfo>,
  menu: 'app' | 'pane',
  paneId: PaneId | null,
  keybindings: KeyBindings | null = null,
): AppMenuNode | null {
  const children = pluginItems(plugins, menu, paneId, keybindings);
  if (children.length === 0) return null;
  return { kind: 'submenu', id: `${menu}-plugins`, label: 'Plugins', children };
}
