import type { SequencedAdapter } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import { Schema } from 'effect';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { StateSequencer, type StreamPosition } from '../stateSequencer';
import { decodeEvent } from '../wireDecode';
import {
  HOST_EVENT_NAMES,
  receiveHostEvent,
  type HostEventHooks,
  type HostEventName,
} from '../hostEvents';
import { KeyBatcher } from '../keyBatching';
import { latencyTracker } from '../../latencyTracker';
import { tracer } from '../../tracer';
import { tauriSchemeUrl } from '../../../utils/platform';

/**
 * Every client command goes to the desktop's one `dispatch` IPC command as
 * the `{ cmd, args }` the web build POSTs to `/commands`; only window chrome
 * has IPC commands of its own (`infra/desktopWindow.ts`, `utils/guiWindows.ts`).
 */
function dispatch<T>(
  invoke: typeof import('@tauri-apps/api/core').invoke,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>('dispatch', { request: { cmd, args: args ?? {} } });
}

/** One host event, as the greeting carries it. */
const GreetingEvent = Schema.Struct({ event: Schema.String, data: Schema.Unknown });

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements SequencedAdapter {
  readonly enumeratesSessions = true;
  private connected = false;
  private reconnectingState = false;
  private unlistenFns: (() => void)[] = [];

  readonly events = new EventHub<DriverEvent>();

  /**
   * The client's copy of the state the stream stage sequences. The Tauri event
   * channel has no ring-buffer replay, so the stage's get_initial_state
   * refetch on a gap is the only recovery path on this transport.
   */
  readonly sequencer = new StateSequencer();

  // Keyboard batching
  private keyBatcher: KeyBatcher | null = null;
  /** Per-instance counter for minting trace action ids (docs/TRACING.md).
   * Client-only on Tauri: IPC has no header to carry it to the backend the way
   * the web `X-Action-Id` does, so this correlates the client-side legs and
   * keeps the two adapters symmetric. */
  private traceActionSeq = 0;

  async connect(): Promise<void> {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { invoke } = await import('@tauri-apps/api/core');

      // Initialize key batcher. The flushed batches MUST go through the same
      // serial queue as run_tmux_command: tauri::invoke spawns each call as its
      // own task with no cross-command ordering, so an unqueued keystroke batch
      // can overtake a queued mutation (or another batch) and land out of order
      // — the exact reordering the serial queue exists to prevent (HttpAdapter
      // routes its batches through sendQueue for the same reason).
      this.keyBatcher = new KeyBatcher((cmd, args) => {
        latencyTracker.markInput();
        const actionId = tracer.isEnabled() ? this.nextActionId() : undefined;
        tracer.event({ layer: 'adapter', name: 'send', kind: 'keys', action_id: actionId });
        this.inFlight++;
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await dispatch(invoke, cmd, args);
          } catch {
            // Ignore errors for fire-and-forget batched commands
          } finally {
            this.inFlight--;
          }
        });
      });

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
        // Action tracing (docs/TRACING.md): the backend says whether it is
        // recording; only then are our events shipped to it.
        'connection-info': (info) => {
          tracer.setServerEnabled(info.trace_enabled === true);
          tracer.setSink((events) => {
            void dispatch(invoke, 'record_trace', { events }).catch(() => {});
          });
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
        Schema.Array(GreetingEvent),
        'greeting',
      )(await dispatch<unknown>(invoke, 'greeting'));
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

    if (this.keyBatcher) {
      this.keyBatcher.destroy();
      this.keyBatcher = null;
    }

    this.connected = false;
    this.reconnectingState = false;
    this.sequencer.reset();
  }

  // Serial queue for mutating commands so they reach the Tauri executor in
  // issue order. Same rationale as HttpAdapter: tauri::invoke spawns each
  // command as its own task, so two commands have no ordering guarantee on
  // their way to the monitor. A `split-window -h` racing past a
  // `select-window -t @B` would split the previous tab.
  private sendQueue: Promise<void> = Promise.resolve();
  /** Commands chained onto the queue and not yet answered, the running one included. */
  private inFlight = 0;

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');

    // Answered raw: the stream stage decodes and adopts it.
    if (cmd === 'get_initial_state') return dispatch<T>(invoke, cmd, args);

    // Check if this is a send-keys command that should be batched
    if (this.keyBatcher?.intercept(cmd, args)) {
      return Promise.resolve(undefined as T);
    }

    // Non-send-keys command: flush all pending batches first to preserve ordering
    this.keyBatcher?.flushAll();

    if (cmd === 'run_tmux_command') {
      latencyTracker.markInput();
      const actionId = tracer.isEnabled() ? this.nextActionId() : undefined;
      tracer.event({ layer: 'adapter', name: 'send', kind: 'command', action_id: actionId });
      let resolveOuter!: (value: T | PromiseLike<T>) => void;
      let rejectOuter!: (reason: unknown) => void;
      const outer = new Promise<T>((res, rej) => {
        resolveOuter = res;
        rejectOuter = rej;
      });
      this.inFlight++;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          const result = await dispatch<T>(invoke, cmd, args);
          resolveOuter(result);
        } catch (err) {
          rejectOuter(err);
        } finally {
          this.inFlight--;
        }
      });
      return outer;
    }

    return dispatch<T>(invoke, cmd, args);
  }

  pendingCommands(): number {
    return this.inFlight + (this.keyBatcher?.hasPending() ? 1 : 0);
  }

  streamPosition(): StreamPosition {
    return this.sequencer.position();
  }

  /**
   * Read from tmux (see TmuxAdapter.query) — straight to the Tauri command
   * rather than onto `sendQueue`: it is answered in-band on the monitor's
   * connection, so the sessions poll can't delay window ops and needs no
   * ordering from here.
   */
  async query(command: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    return dispatch<string>(invoke, 'query_tmux', { command });
  }

  /** Bumped per staged page, so each one is a new URL and the frame reloads. */
  private previewVersion = 0;

  /** Stage a preview pane's page; its frame loads it from `tmuxypreview:`. */
  async stagePreview(paneId: string, html: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    await dispatch(invoke, 'stage_preview', { paneId, html });
    return tauriSchemeUrl(
      'tmuxypreview',
      `/${paneId.replace(/^%/, '')}?v=${++this.previewVersion}`,
    );
  }

  /** Mint a per-instance action id (e.g. `a-t-17`); the `t` marks the Tauri
   * transport so ids don't collide with the web adapter's `a-<conn>-n`. */
  private nextActionId(): string {
    this.traceActionSeq += 1;
    return `a-t-${this.traceActionSeq}`;
  }

  async switchSession(newSession: string): Promise<void> {
    const command = toTmuxCommand(TmuxOp.SwitchClient({ session: newSession }));
    await this.invoke<void>('run_tmux_command', { command });
  }
}
