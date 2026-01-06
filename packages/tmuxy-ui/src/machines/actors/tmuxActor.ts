import { fromCallback } from 'xstate';
import { createAdapter } from '../../tmux/adapters';
import type { TmuxAdapter, ServerState } from '../../tmux/types';

export interface TmuxActorInput {
  onConnected: () => void;
  onStateUpdate: (state: ServerState) => void;
  onError: (error: string) => void;
  onDisconnected: () => void;
}

export interface TmuxActorEmit {
  type: 'SEND_COMMAND';
  command: string;
}

/**
 * Tmux actor - handles WebSocket/Tauri communication
 *
 * Uses fromCallback to manage the adapter lifecycle:
 * - Connects on actor start
 * - Sends events to parent via input callbacks
 * - Receives commands from parent via receive callback
 * - Disconnects on actor stop
 */
export const tmuxActor = fromCallback<TmuxActorEmit, TmuxActorInput>(
  ({ input, receive }) => {
    const adapter: TmuxAdapter = createAdapter();

    // Subscribe to adapter events
    const unsubscribeState = adapter.onStateChange((state) => {
      input.onStateUpdate(state);
    });

    const unsubscribeError = adapter.onError((error) => {
      input.onError(error);
    });

    // Connect to backend
    adapter
      .connect()
      .then(() => {
        input.onConnected();
        // Request initial state
        adapter.invoke('get_state').catch(console.error);
      })
      .catch((error) => {
        input.onError(error.message || 'Failed to connect');
      });

    // Handle commands from parent machine
    receive((event) => {
      if (event.type === 'SEND_COMMAND') {
        adapter
          .invoke<void>('send_command', { command: event.command })
          .catch((error) => {
            input.onError(error.message || 'Command failed');
          });
      }
    });

    // Cleanup on actor stop
    return () => {
      unsubscribeState();
      unsubscribeError();
      adapter.disconnect();
    };
  }
);

/**
 * Helper to send command to tmux actor
 */
export function sendTmuxCommand(command: string): TmuxActorEmit {
  return { type: 'SEND_COMMAND', command };
}
