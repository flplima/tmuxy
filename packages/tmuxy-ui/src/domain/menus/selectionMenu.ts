/** The selection menu: two things to do with selected text — copy it, or type it into the pane. */

import { local, tidy, type MenuEnv, type MenuSpec } from './spec';

export function selectionMenuSpec(env: MenuEnv): MenuSpec {
  return tidy([
    { kind: 'item', id: 'selection-copy', label: 'Copy', icon: 'copy', action: local('copy') },
    !env.readOnly && {
      kind: 'item',
      id: 'selection-send-keys',
      label: 'Send keys',
      icon: 'send-keys',
      action: local('send-keys'),
    },
  ]);
}
