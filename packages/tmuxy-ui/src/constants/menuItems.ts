/**
 * Menu items and prefix key bindings for the tmux dropdown menu
 */

export interface TmuxMenuItem {
  label: string;
  key?: string;
  command?: string;
  divider?: boolean;
}

/**
 * Prefix key bindings - maps key (after prefix) to tmux command
 * These match the bindings in keyboardActor.ts and tmuxy.conf
 */
export const PREFIX_BINDINGS: Record<string, TmuxMenuItem> = {
  'c': { label: 'New Window', key: 'c', command: 'new-window' },
  'n': { label: 'Next Window', key: 'n', command: 'next-window' },
  'p': { label: 'Previous Window', key: 'p', command: 'previous-window' },
  '"': { label: 'Split Horizontal', key: '"', command: 'split-window -v' },
  '%': { label: 'Split Vertical', key: '%', command: 'split-window -h' },
  'z': { label: 'Zoom Pane', key: 'z', command: 'resize-pane -Z' },
  'x': { label: 'Kill Pane', key: 'x', command: 'kill-pane' },
  'd': { label: 'Detach', key: 'd', command: 'detach-client' },
  '[': { label: 'Copy Mode', key: '[', command: 'copy-mode' },
};

export const TMUX_MENU_ITEMS: TmuxMenuItem[] = [
  { label: 'New Window', key: 'c', command: 'new-window' },
  { label: 'Next Window', key: 'n', command: 'next-window' },
  { label: 'Previous Window', key: 'p', command: 'previous-window' },
  { divider: true, label: '' },
  { label: 'Split Horizontal', key: '"', command: 'split-window -v' },
  { label: 'Split Vertical', key: '%', command: 'split-window -h' },
  { divider: true, label: '' },
  { label: 'Zoom Pane', key: 'z', command: 'resize-pane -Z' },
  { label: 'Kill Pane', key: 'x', command: 'kill-pane' },
  { divider: true, label: '' },
  { label: 'Copy Mode', key: '[', command: 'copy-mode' },
  { label: 'Detach', key: 'd', command: 'detach-client' },
];
