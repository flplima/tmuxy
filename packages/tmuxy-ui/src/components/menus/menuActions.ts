/**
 * menuActions - Central dispatch for menu item actions
 *
 * Maps action IDs to send() calls on the app machine.
 */

import type { AppMachineEvent } from '../../machines/types';

const GITHUB_URL = 'https://github.com/flplima/tmuxy';

type Send = (event: AppMachineEvent) => void;

/**
 * Resolve the pane a menu "Close Pane" should target when the menu isn't
 * anchored to a specific pane (the hamburger AppMenu and the Tauri native
 * menu): the focused float, else the real active pane, else undefined so the
 * caller falls back to tmux's server-active pane. Mirrors the focus-target
 * resolution every keyboardActor path uses (`focusedFloatPaneId ??
 * realPaneId(activePaneId)`), so close hits the pane the user sees as active.
 */
export function activeCloseTarget(
  activePaneId: string | null,
  focusedFloatPaneId: string | null,
): string | undefined {
  const realActive =
    activePaneId && !activePaneId.startsWith('__placeholder_') ? activePaneId : null;
  return focusedFloatPaneId ?? realActive ?? undefined;
}

/**
 * Execute a menu action by ID. `closeTargetPaneId` — when the caller knows the
 * pane a group-aware "Close Pane" should act on — routes pane-close through the
 * group-aware CLOSE_PANE path instead of a raw kill-pane that bypasses group
 * teardown (see activeCloseTarget).
 */
export function executeMenuAction(send: Send, actionId: string, closeTargetPaneId?: string): void {
  switch (actionId) {
    // Pane actions
    case 'pane-split-below':
      send({ type: 'SEND_COMMAND', command: 'split-window -v' });
      break;
    case 'pane-split-right':
      send({ type: 'SEND_COMMAND', command: 'split-window -h' });
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
          'run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-add #{pane_id} #{pane_width} #{pane_height}"',
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
      // Group members and floats need the group-aware close script; a raw
      // kill-pane leaves the group window and its @tmuxy-group-panes option
      // stale. Route through CLOSE_PANE when we know which pane to close;
      // otherwise fall back to tmux's server-active pane.
      if (closeTargetPaneId) {
        send({ type: 'CLOSE_PANE', paneId: closeTargetPaneId });
      } else {
        send({ type: 'SEND_COMMAND', command: 'kill-pane' });
      }
      break;

    // Tab actions
    case 'tab-new':
      send({ type: 'CREATE_TAB' });
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
    case 'session-new': {
      // Create a fresh session AND switch to it so the action has a visible
      // effect — bare `new-session -d` created a detached session with no UI
      // feedback ("did nothing visible"). Mirrors the session picker's "new"
      // path: create, then switch. On web the switch reconnects with
      // ?session=<name> and the server's attach creates the session if the
      // create command hasn't landed yet; on Tauri the create must precede
      // switch-client, and XState delivers both events to the tmux actor in
      // order. The name mirrors the picker's `tmuxy_<n>` convention.
      const newSession = `tmuxy_${Date.now()}`;
      send({ type: 'SEND_COMMAND', command: `new-session -d -s ${newSession}` });
      send({ type: 'SWITCH_SESSION', sessionName: newSession });
      break;
    }
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
      // tmuxy's own config, NOT ~/.tmux.conf — sourcing the user's vanilla
      // tmux config would drag their default-server bindings/options into
      // the isolated tmuxy socket.
      send({ type: 'SEND_COMMAND', command: 'source-file ~/.config/tmuxy/tmuxy.conf' });
      break;

    // View actions
    case 'view-zoom':
      send({ type: 'SEND_COMMAND', command: 'resize-pane -Z' });
      break;
    case 'view-layout-even-horizontal':
      send({ type: 'SEND_COMMAND', command: 'select-layout even-horizontal' });
      break;
    case 'view-layout-even-vertical':
      send({ type: 'SEND_COMMAND', command: 'select-layout even-vertical' });
      break;
    case 'view-layout-main-horizontal':
      send({ type: 'SEND_COMMAND', command: 'select-layout main-horizontal' });
      break;
    case 'view-layout-main-vertical':
      send({ type: 'SEND_COMMAND', command: 'select-layout main-vertical' });
      break;
    case 'view-layout-tiled':
      send({ type: 'SEND_COMMAND', command: 'select-layout tiled' });
      break;

    // Help actions
    case 'help-github':
      window.open(GITHUB_URL, '_blank');
      break;
  }
}
