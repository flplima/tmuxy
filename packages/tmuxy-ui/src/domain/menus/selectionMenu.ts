/**
 * The selection menu: copy the selected text, type it into the pane, or hand
 * it to a plugin's selection action (which gets it in a file).
 */

import type { PluginInfo } from '../plugins';
import { pluginItems } from './pluginMenu';
import { local, separator, tidy, type MenuSpec } from './spec';

export function selectionMenuSpec(plugins: ReadonlyArray<PluginInfo> = []): MenuSpec {
  return tidy([
    { kind: 'item', id: 'selection-copy', label: 'Copy', icon: 'copy', action: local('copy') },
    {
      kind: 'item',
      id: 'selection-send-keys',
      label: 'Send keys',
      icon: 'send-keys',
      action: local('send-keys'),
    },
    separator,
    ...pluginItems(plugins, 'selection', null),
  ]);
}
