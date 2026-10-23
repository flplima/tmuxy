/**
 * The key bindings the guest transports report, since a guest has no server
 * to ask: the shipped tmuxy.defaults.conf (packages/tmuxy-core/assets) as
 * the keyboard actor expects it, plus the tmux defaults the guest's tmux
 * binds on its own. `__tests__/keybindings.conf.test.ts` holds this table to
 * the conf: every root binding and sticky-table key the conf binds is here
 * with the same command, and nothing is here the conf does not bind.
 */

import type { KeyBindings } from '../../../../domain/wire';
import { STICKY_TABLE_ENTRIES, STICKY_TABLES } from '../stickyTables';

export const DEFAULT_KEYBINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  prefix_bindings: [
    { key: '-', command: 'split-window -v', description: 'Split horizontally' },
    { key: '|', command: 'split-window -h', description: 'Split vertically' },
    { key: '\\', command: 'split-window -h', description: 'Split vertically' },
    { key: '"', command: 'split-window -v', description: 'Split horizontally' },
    { key: '%', command: 'split-window -h', description: 'Split vertically' },
    { key: 'c', command: 'new-window', description: 'New window' },
    ...STICKY_TABLE_ENTRIES,
    { key: 'H', command: 'resize-pane -L 5', description: 'Resize left', repeat: true },
    { key: 'J', command: 'resize-pane -D 5', description: 'Resize down', repeat: true },
    { key: 'K', command: 'resize-pane -U 5', description: 'Resize up', repeat: true },
    { key: 'L', command: 'resize-pane -R 5', description: 'Resize right', repeat: true },
    { key: '=', command: 'tmuxy-pane-group-add', description: 'Add pane to group' },
    { key: '>', command: 'swap-pane -D', description: 'Swap pane down' },
    { key: '<', command: 'swap-pane -U', description: 'Swap pane up' },
    // tmux's own defaults, which the conf leaves in place.
    { key: 'n', command: 'next-window', description: 'Next window' },
    { key: 'x', command: 'kill-pane', description: 'Kill pane' },
    { key: '&', command: 'kill-window', description: 'Kill window' },
    { key: 'o', command: 'select-pane -t :.+', description: 'Next pane' },
    { key: 'z', command: 'resize-pane -Z', description: 'Zoom pane' },
    { key: 'Up', command: 'select-pane -U', description: 'Pane above' },
    { key: 'Down', command: 'select-pane -D', description: 'Pane below' },
    { key: 'Left', command: 'select-pane -L', description: 'Pane left' },
    { key: 'Right', command: 'select-pane -R', description: 'Pane right' },
    { key: '[', command: 'copy-mode', description: 'Enter copy mode' },
    { key: 'Space', command: 'next-layout', description: 'Next layout' },
    { key: '0', command: 'select-window -t :=0', description: 'Window 0' },
    { key: '1', command: 'select-window -t :=1', description: 'Window 1' },
    { key: '2', command: 'select-window -t :=2', description: 'Window 2' },
  ],
  // Ctrl+hjkl / Ctrl+arrows: group-aware directional pane navigation via the
  // `tmuxy-nav-*` command-aliases, which tmuxy.essentials.conf defines and
  // the guest's defaults conf sources (both guest image builds ship both).
  // Intercepted client-side so the key isn't sent to the pane as literal
  // text. Ctrl+digit is the client's own, as the conf says, so it is not
  // bound here either.
  root_bindings: [
    { key: 'C-h', command: 'tmuxy-nav-left', description: 'Navigate left' },
    { key: 'C-j', command: 'tmuxy-nav-down', description: 'Navigate down' },
    { key: 'C-k', command: 'tmuxy-nav-up', description: 'Navigate up' },
    { key: 'C-l', command: 'tmuxy-nav-right', description: 'Navigate right' },
    { key: 'C-Left', command: 'tmuxy-nav-left', description: 'Navigate left' },
    { key: 'C-Right', command: 'tmuxy-nav-right', description: 'Navigate right' },
    { key: 'C-Up', command: 'tmuxy-nav-up', description: 'Navigate up' },
    { key: 'C-Down', command: 'tmuxy-nav-down', description: 'Navigate down' },
    { key: 'C-Tab', command: 'next-window', description: 'Next window' },
    { key: 'C-S-Tab', command: 'previous-window', description: 'Previous window' },
  ],
  tables: STICKY_TABLES,
};
