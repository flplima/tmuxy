/**
 * The PANE and TAB key tables for the transport that carries its own key
 * bindings (v86): the same keys the shipped tmuxy.defaults.conf
 * (packages/tmuxy-core/assets) binds, limited to commands it can run. A test
 * holds the two to each other.
 */

import type { KeyBindings } from '../../../domain/wire';

type Binding = KeyBindings['prefix_bindings'][number];

const bind = (key: string, command: string, description: string): Binding => ({
  key,
  command,
  description,
});

/** `prefix p` and `prefix t`: the way into the two tables. */
export const STICKY_TABLE_ENTRIES: Binding[] = [
  { key: 'p', command: 'switch-client -T pane', description: 'Pane mode' },
  { key: 't', command: 'switch-client -T tab', description: 'Tab mode' },
];

export const STICKY_TABLES: KeyBindings['tables'] = {
  pane: [
    bind('h', 'tmuxy-nav-left', 'Focus left'),
    bind('j', 'tmuxy-nav-down', 'Focus down'),
    bind('k', 'tmuxy-nav-up', 'Focus up'),
    bind('l', 'tmuxy-nav-right', 'Focus right'),
    bind('H', 'resize-pane -L 5', 'Resize left'),
    bind('J', 'resize-pane -D 5', 'Resize down'),
    bind('K', 'resize-pane -U 5', 'Resize up'),
    bind('L', 'resize-pane -R 5', 'Resize right'),
    bind('-', 'split-window -v', 'Split below'),
    bind('|', 'split-window -h', 'Split right'),
    bind('x', 'kill-pane', 'Close pane'),
    bind('z', 'resize-pane -Z', 'Zoom pane'),
    bind('>', 'swap-pane -D', 'Swap with next'),
    bind('<', 'swap-pane -U', 'Swap with previous'),
    bind('b', 'break-pane', 'Break to tab'),
  ],
  tab: [
    bind('h', 'previous-window', 'Previous tab'),
    bind('l', 'next-window', 'Next tab'),
    bind('c', 'new-window', 'New tab'),
    bind('x', 'kill-window', 'Close tab'),
    ...Array.from({ length: 9 }, (_, i) =>
      bind(String(i + 1), `select-window -t ${i + 1}`, `Tab ${i + 1}`),
    ),
    {
      key: ',',
      command: 'command-prompt -I "#W" "rename-window -- \\"%%%\\""',
      description: 'Rename tab',
    },
  ],
};
