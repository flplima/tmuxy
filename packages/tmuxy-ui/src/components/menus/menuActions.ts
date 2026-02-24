/**
 * menuActions - Central dispatch for menu item actions
 *
 * Maps action IDs to send() calls on the app machine.
 */

import type { AppMachineEvent } from '../../machines/types';

const GITHUB_URL = 'https://github.com/niclas3332/tmuxy';

type Send = (event: AppMachineEvent) => void;

/**
 * Execute a menu action by ID.
 */
export function executeMenuAction(send: Send, actionId: string): void {
  switch (actionId) {
    // Pane actions
    case 'pane-split-below':
      send({ type: 'SEND_COMMAND', command: 'split-window -v' });
      break;
    case 'pane-split-right':
      send({ type: 'SEND_COMMAND', command: 'split-window -h' });
      break;
    case 'pane-navigate-up':
      send({ type: 'SEND_COMMAND', command: 'select-pane -U' });
      break;
    case 'pane-navigate-down':
      send({ type: 'SEND_COMMAND', command: 'select-pane -D' });
      break;
    case 'pane-navigate-left':
      send({ type: 'SEND_COMMAND', command: 'select-pane -L' });
      break;
    case 'pane-navigate-right':
      send({ type: 'SEND_COMMAND', command: 'select-pane -R' });
      break;
    case 'pane-next':
      send({ type: 'SEND_COMMAND', command: 'select-pane -t :.+' });
      break;
    case 'pane-previous':
      send({ type: 'SEND_COMMAND', command: 'last-pane' });
      break;
    case 'pane-swap-prev':
      send({ type: 'SEND_COMMAND', command: 'swap-pane -U' });
      break;
    case 'pane-swap-next':
      send({ type: 'SEND_COMMAND', command: 'swap-pane -D' });
      break;
    case 'pane-move-new-tab':
      send({ type: 'SEND_COMMAND', command: 'break-pane' });
      break;
    case 'pane-add-to-group':
      send({
        type: 'SEND_TMUX_COMMAND',
        command:
          'run-shell "/workspace/scripts/tmuxy/pane-group-add.sh #{pane_id} #{pane_width} #{pane_height}"',
      });
      break;
    case 'pane-copy-mode':
      send({ type: 'SEND_COMMAND', command: 'copy-mode' });
      break;
    case 'pane-paste':
      send({ type: 'SEND_COMMAND', command: 'paste-buffer' });
      break;
    case 'pane-clear':
      send({ type: 'SEND_COMMAND', command: 'send-keys -R \\; clear-history' });
      break;
    case 'pane-close':
      send({ type: 'SEND_COMMAND', command: 'kill-pane' });
      break;

    // Tab actions
    case 'tab-new':
      send({ type: 'SEND_COMMAND', command: 'new-window' });
      break;
    case 'tab-next':
      send({ type: 'SEND_COMMAND', command: 'next-window' });
      break;
    case 'tab-previous':
      send({ type: 'SEND_COMMAND', command: 'previous-window' });
      break;
    case 'tab-last':
      send({ type: 'SEND_COMMAND', command: 'last-window' });
      break;
    case 'tab-rename':
      send({ type: 'SEND_COMMAND', command: 'command-prompt -I "#W" "rename-window -- \'%%\'"' });
      break;
    case 'tab-close':
      send({ type: 'SEND_COMMAND', command: 'kill-window' });
      break;

    // Session actions
    case 'session-new':
      send({ type: 'SEND_COMMAND', command: 'new-session -d' });
      break;
    case 'session-rename':
      send({ type: 'SEND_COMMAND', command: 'command-prompt -I "#S" "rename-session -- \'%%\'"' });
      break;
    case 'session-detach':
      send({ type: 'SEND_COMMAND', command: 'detach-client' });
      break;
    case 'session-kill':
      send({ type: 'SEND_COMMAND', command: 'kill-session' });
      break;
    case 'session-reload-config':
      send({ type: 'SEND_COMMAND', command: 'source-file ~/.tmux.conf' });
      break;

    // View actions
    case 'view-zoom':
      send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
      break;
    case 'view-next-layout':
      send({ type: 'SEND_COMMAND', command: 'next-layout' });
      break;

    // Help actions
    case 'help-keybindings':
      send({ type: 'SEND_COMMAND', command: 'list-keys' });
      break;
    case 'help-github':
      window.open(GITHUB_URL, '_blank');
      break;
  }
}
