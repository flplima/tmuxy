import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxAdapter, ServerState, KeyBindings } from '../../tmux/types';

export type TmuxActorEvent =
  | { type: 'SEND_COMMAND'; command: string }
  | { type: 'INVOKE'; cmd: string; args?: Record<string, unknown> }
  | { type: 'FETCH_INITIAL_STATE'; cols: number; rows: number }
  | { type: 'FETCH_SCROLLBACK_CELLS'; paneId: string; start: number; end: number }
  | { type: 'FETCH_THEME_SETTINGS' }
  | { type: 'FETCH_THEMES_LIST' };

export interface TmuxActorInput {
  parent: AnyActorRef;
}

/**
 * Create a tmux actor with the given adapter.
 *
 * The actor handles WebSocket/Tauri communication:
 * - Connects on actor start
 * - Sends events to parent via parent.send()
 * - Receives commands from parent via receive callback
 * - Disconnects on actor stop
 */
export function createTmuxActor(adapter: TmuxAdapter) {
  return fromCallback<TmuxActorEvent, TmuxActorInput>(({ input, receive }) => {
    const { parent } = input;

    // Subscribe to adapter events
    const unsubscribeState = adapter.onStateChange((state: ServerState) => {
      parent.send({ type: 'TMUX_STATE_UPDATE', state });
    });

    const unsubscribeError = adapter.onError((error: string) => {
      parent.send({ type: 'TMUX_ERROR', error });
    });

    const unsubscribeKeyBindings = adapter.onKeyBindings((keybindings: KeyBindings) => {
      parent.send({ type: 'KEYBINDINGS_RECEIVED', keybindings });
    });

    const unsubscribeConnectionInfo = adapter.onConnectionInfo(
      (connectionId: number, defaultShell: string) => {
        parent.send({ type: 'CONNECTION_INFO', connectionId, defaultShell });
      },
    );

    // Connect to backend
    adapter
      .connect()
      .then(() => {
        parent.send({ type: 'TMUX_CONNECTED' });
      })
      .catch((error) => {
        parent.send({ type: 'TMUX_ERROR', error: error.message || 'Failed to connect' });
      });

    // Handle commands from parent machine
    receive((event) => {
      if (event.type === 'SEND_COMMAND') {
        adapter.invoke<void>('run_tmux_command', { command: event.command }).catch((error) => {
          parent.send({ type: 'TMUX_ERROR', error: error.message || 'Command failed' });
        });
      } else if (event.type === 'INVOKE') {
        adapter.invoke(event.cmd, event.args || {}).catch((error) => {
          parent.send({ type: 'TMUX_ERROR', error: error.message || 'Invoke failed' });
        });
      } else if (event.type === 'FETCH_INITIAL_STATE') {
        adapter
          .invoke<ServerState>('get_initial_state', { cols: event.cols, rows: event.rows })
          .then((state) => {
            parent.send({ type: 'TMUX_STATE_UPDATE', state });
          })
          .catch((error) => {
            parent.send({ type: 'TMUX_ERROR', error: error.message || 'Failed to fetch state' });
          });
      } else if (event.type === 'FETCH_SCROLLBACK_CELLS') {
        adapter
          .invoke<{
            cells: import('../../tmux/types').PaneContent;
            historySize: number;
            start: number;
            end: number;
            width: number;
          }>('get_scrollback_cells', {
            paneId: event.paneId,
            start: event.start,
            end: event.end,
          })
          .then((result) => {
            parent.send({
              type: 'COPY_MODE_CHUNK_LOADED',
              paneId: event.paneId,
              cells: result.cells,
              start: result.start,
              end: result.end,
              historySize: result.historySize,
              width: result.width,
            });
          })
          .catch((error) => {
            console.error('[tmuxActor] Fetch scrollback cells failed:', error);
          });
      } else if (event.type === 'FETCH_THEME_SETTINGS') {
        adapter
          .invoke<{ theme: string; mode: string }>('get_theme_settings', {})
          .then((result) => {
            parent.send({
              type: 'THEME_SETTINGS_RECEIVED',
              theme: result.theme || 'default',
              mode: (result.mode === 'light' ? 'light' : 'dark') as 'dark' | 'light',
            });
          })
          .catch((error) => {
            console.error('[tmuxActor] Fetch theme settings failed:', error);
          });
      } else if (event.type === 'FETCH_THEMES_LIST') {
        // Fetch from HTTP API (not via adapter/commands)
        fetch('/api/themes')
          .then((res) => res.json())
          .then((themes: Array<{ name: string; displayName: string }>) => {
            parent.send({ type: 'THEMES_LIST_RECEIVED', themes });
          })
          .catch((error) => {
            console.error('[tmuxActor] Fetch themes list failed:', error);
          });
      }
    });

    // Cleanup on actor stop
    return () => {
      unsubscribeState();
      unsubscribeError();
      unsubscribeKeyBindings();
      unsubscribeConnectionInfo();
      adapter.disconnect();
    };
  });
}

/**
 * Helper to send command to tmux actor
 */
export function sendTmuxCommand(command: string): TmuxActorEvent {
  return { type: 'SEND_COMMAND', command };
}
