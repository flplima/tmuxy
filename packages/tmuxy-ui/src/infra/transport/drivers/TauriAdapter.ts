import type { SequencedDriver } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import { BACKEND_COMMANDS, backendCall, type BackendCall } from '../../../domain/backendCalls';
import type { PaneId } from '../../../domain/ids';
import { StateSequencer } from '../stateSequencer';
import { decodeEvent } from '../wireDecode';
import {
  HOST_EVENT_NAMES,
  receiveHostEvent,
  type HostEventHooks,
  type HostEventName,
} from '../hostEvents';
import { tauriSchemeUrl } from '../../platform';

/**
 * Every client command goes to the desktop's one `dispatch` IPC command as
 * the `{ cmd, args }` the web build POSTs to `/commands`; only window chrome
 * has IPC commands of its own (`infra/desktopWindow.ts`, `infra/guiWindows.ts`).
 * IPC has no header to carry a trace `action_id`, so the client's legs of a
 * command are traced and the host's are not joined to them.
 */
async function dispatch(call: BackendCall): Promise<unknown> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('dispatch', { request: call });
}

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements SequencedDriver {
  readonly enumeratesSessions = true;
  readonly answersQueries = true;
  private connected = false;
  private reconnectingState = false;
  private unlistenFns: (() => void)[] = [];

  readonly events = new EventHub<DriverEvent>();

  /**
   * The client's copy of the state the stream stage sequences. The Tauri event
   * channel has no ring-buffer replay, so the stage's full-state refetch on a
   * gap is the only recovery path on this transport.
   */
  readonly sequencer = new StateSequencer();

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');

      // What this link does on an event besides publishing it. The monitor
      // runs in this process, so its tmux connection is the link: it is down
      // from a `reconnecting` until the next state arrives, and a state is
      // the ONLY signal that a deliberate detach has ended (the monitor
      // parks, and a user reconnect revives it with nothing in between).
      const hooks: HostEventHooks = {
        'state-update': () => {
          const wasDown = !this.connected || this.reconnectingState;
          this.connected = true;
          if (wasDown) {
            this.reconnectingState = false;
            this.events.emit(TransportEvent.Reconnection({ reconnecting: false }));
          }
        },
        reconnecting: () => {
          this.connected = false;
          if (!this.reconnectingState) {
            this.reconnectingState = true;
            this.events.emit(TransportEvent.Reconnection({ reconnecting: true }));
          }
        },
        // Terminal: no further events.
        fatal: () => {
          this.connected = false;
          this.reconnectingState = false;
        },
        // A deliberate detach is NOT a failure: clearing `reconnectingState`
        // here is what stops the adapter presenting it as a retry.
        detached: () => {
          this.connected = false;
          this.reconnectingState = false;
        },
      };
      const receive = (name: HostEventName, raw: unknown): void => {
        const published = receiveHostEvent(name, raw, hooks);
        if (published) this.events.emit(published);
      };
      for (const name of HOST_EVENT_NAMES) {
        const unlisten = await listen<unknown>(name, (event) => receive(name, event.payload));
        this.unlistenFns.push(unlisten);
      }

      this.connected = true;

      // The greeting: who this client is, and the bindings when the monitor
      // has read them — the events it sent before this webview listened.
      const greeting = decodeEvent(
        BACKEND_COMMANDS.greeting.result,
        'greeting',
      )(await dispatch(backendCall('greeting', {})));
      for (const { event, data } of greeting ?? []) {
        if ((HOST_EVENT_NAMES as string[]).includes(event)) receive(event as HostEventName, data);
      }
    } catch (e) {
      this.events.emit(TransportEvent.Error({ message: 'Failed to connect to Tauri' }));
      throw e;
    }
  }

  disconnect(): void {
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    this.connected = false;
    this.reconnectingState = false;
    this.sequencer.reset();
  }

  send(call: BackendCall): Promise<unknown> {
    return dispatch(call);
  }

  /** Bumped per staged page, so each one is a new URL and the frame reloads. */
  private previewVersion = 0;

  /** Stage a preview pane's page; its frame loads it from `tmuxypreview:`. */
  async stagePreview(paneId: PaneId, html: string): Promise<string> {
    await dispatch(backendCall('stage_preview', { paneId, html }));
    return tauriSchemeUrl(
      'tmuxypreview',
      `/${paneId.replace(/^%/, '')}?v=${++this.previewVersion}`,
    );
  }
}
