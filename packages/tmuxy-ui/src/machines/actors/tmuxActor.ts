import { fromCallback, type AnyActorRef } from 'xstate';
import type { TmuxAdapter, ServerState } from '../../tmux/types';

export type TmuxActorEvent =
  | { type: 'SEND_COMMAND'; command: string }
  | { type: 'INVOKE'; cmd: string; args?: Record<string, unknown> }
  | { type: 'FETCH_INITIAL_STATE'; cols: number; rows: number };

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
        adapter
          .invoke<void>('run_tmux_command', { command: event.command })
          .catch((error) => {
            parent.send({ type: 'TMUX_ERROR', error: error.message || 'Command failed' });
          });
      } else if (event.type === 'INVOKE') {
        adapter
          .invoke(event.cmd, event.args || {})
          .catch((error) => {
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
      }
    });

    // Cleanup on actor stop
    return () => {
      unsubscribeState();
      unsubscribeError();
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
