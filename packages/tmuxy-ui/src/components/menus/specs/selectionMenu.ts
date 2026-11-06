/**
 * The selection menu: copy the selected text, type it into the pane, or hand
 * it to a plugin's selection action (which gets it in a file).
 */

import type { PluginInfo } from '../../../domain/plugins';
import { pluginItems } from './pluginMenu';
import { separator, tidy } from '../../../domain/menus/spec';
import { local, type AppMenuSpec } from './actions';

export function selectionMenuSpec(plugins: ReadonlyArray<PluginInfo> = []): AppMenuSpec {
  return tidy([
    {
      kind: 'item',
      id: 'selection-copy',
      label: 'Copy',
      icon: 'copy',
      action: local({ verb: 'copy-selection' }),
    },
    {
      kind: 'item',
      id: 'selection-send-keys',
      label: 'Send keys',
      icon: 'send-keys',
      action: local({ verb: 'send-selection' }),
    },
    separator,
    ...pluginItems(plugins, 'selection', null),
  ]);
}
