/**
 * The sticky PANE and TAB tables for the transports that carry their own key
 * bindings (the demo and v86): the same keys .devcontainer/.tmuxy.defaults.conf
 * binds, limited to commands both can run. Each binding re-enters its table,
 * which is what keeps a tmux table sticky (domain/keyTables.ts).
 */

import type { KeyBindings } from '../../../domain/wire';

type Binding = KeyBindings['prefix_bindings'][number];

const sticky = (table: string, key: string, command: string, description: string): Binding => ({
  key,
  command: `${command} \\; switch-client -T ${table}`,
  description,
});

/** `prefix p` and `prefix t`: the way into the two tables. */
export const STICKY_TABLE_ENTRIES: Binding[] = [
  { key: 'p', command: 'switch-client -T pane', description: 'Pane mode' },
  { key: 't', command: 'switch-client -T tab', description: 'Tab mode' },
];

export const STICKY_TABLES: KeyBindings['tables'] = {
  pane: [
    sticky('pane', 'h', 'select-pane -L', 'Focus left'),
    sticky('pane', 'j', 'select-pane -D', 'Focus down'),
    sticky('pane', 'k', 'select-pane -U', 'Focus up'),
    sticky('pane', 'l', 'select-pane -R', 'Focus right'),
    sticky('pane', 'H', 'resize-pane -L 5', 'Resize left'),
    sticky('pane', 'J', 'resize-pane -D 5', 'Resize down'),
    sticky('pane', 'K', 'resize-pane -U 5', 'Resize up'),
    sticky('pane', 'L', 'resize-pane -R 5', 'Resize right'),
    sticky('pane', '-', 'split-window -v', 'Split below'),
    sticky('pane', '|', 'split-window -h', 'Split right'),
    sticky('pane', 'x', 'kill-pane', 'Close pane'),
    sticky('pane', 'z', 'resize-pane -Z', 'Zoom pane'),
    sticky('pane', '>', 'swap-pane -D', 'Swap with next'),
    sticky('pane', '<', 'swap-pane -U', 'Swap with previous'),
    sticky('pane', 'b', 'break-pane', 'Break to tab'),
  ],
  tab: [
    sticky('tab', 'h', 'previous-window', 'Previous tab'),
    sticky('tab', 'l', 'next-window', 'Next tab'),
    sticky('tab', 'c', 'new-window', 'New tab'),
    sticky('tab', 'x', 'kill-window', 'Close tab'),
    ...Array.from({ length: 9 }, (_, i) =>
      sticky('tab', String(i + 1), `select-window -t ${i + 1}`, `Tab ${i + 1}`),
    ),
    {
      key: ',',
      command: 'command-prompt -I "#W" "rename-window -- \'%%\'"',
      description: 'Rename tab',
    },
  ],
};
