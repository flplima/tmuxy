import type { SequencedAdapter } from '../driver';
import { EventHub } from '../../eventHub';
import { TransportEvent, type DriverEvent } from '../events';
import {
  ClipboardEvent,
  DetachedEvent,
  KeyBindings,
  LogEvent,
  MessageFrame,
  ThemeSettings,
} from '../../../domain/wire';
import { Schema } from 'effect';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { StateSequencer } from '../stateSequencer';
import { decodeEvent } from '../wireDecode';
import { KeyBatcher } from '../keyBatching';
import { latencyTracker } from '../../latencyTracker';
import { tracer } from '../../tracer';

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
  /** Per-instance counter for minting trace action ids (docs/TELEMETRY.md).
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
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await invoke(cmd, args);
          } catch {
            // Ignore errors for fire-and-forget batched commands
          }
        });
      });

      // Every event payload is decoded against its schema; a handler only
      // ever sees one that matched.
      const on = async <A, I>(
        name: string,
        schema: Schema.Schema<A, I>,
        handle: (payload: A) => void,
      ): Promise<void> => {
        const decode = decodeEvent(schema, name);
        const unlisten = await listen<unknown>(name, (event) => {
          const payload = decode(event.payload);
          if (payload !== null) handle(payload);
        });
        this.unlistenFns.push(unlisten);
      };

      // State updates (full or delta), decoded and sequenced by the stream stage.
      const unlistenState = await listen<unknown>('tmux-state-update', (event) => {
        this.events.emit({ _tag: 'StateReceived', payload: event.payload });

        // A successful state update means we're connected — and is the ONLY
        // signal that a deliberate detach has ended. The detach path leaves
        // both flags false (see the `tmux-detached` listener), the monitor
        // parks, and a user reconnect revives it with no `tmux-error` in
        // between; gating the recovery notice on `reconnectingState` alone
        // therefore never fired, and the app stayed blurred behind the
        // detached overlay over a perfectly live connection.
        const wasDown = !this.connected || this.reconnectingState;
        this.connected = true;
        if (wasDown) {
          this.reconnectingState = false;
          this.events.emit(TransportEvent.Reconnection({ reconnecting: false }));
        }
      });
      this.unlistenFns.push(unlistenState);

      await on('tmux-keybindings', KeyBindings, (keybindings) =>
        this.events.emit(TransportEvent.KeyBindings({ keybindings })),
      );

      // Theme + appearance, re-pushed after the config is sourced
      await on('tmux-theme-settings', ThemeSettings, (settings) =>
        this.events.emit(TransportEvent.ThemeSettings({ settings })),
      );

      // Streaming connection-time progress (each command + output)
      await on('tmux-log', LogEvent, (payload) =>
        this.events.emit(TransportEvent.Log({ kind: payload.kind, message: payload.message })),
      );

      // OSC 52 clipboard write requests from terminal applications, forwarded
      // by monitor.rs. Mirrored into the system clipboard by the tmux actor.
      // Without this the desktop app silently drops every terminal clipboard
      // write (HttpAdapter has the same listener).
      await on('tmux-clipboard', ClipboardEvent, (payload) =>
        this.events.emit(TransportEvent.Clipboard({ paneId: payload.pane_id, text: payload.text })),
      );

      // Backend gave up reconnecting — terminal state, no further events.
      await on('tmux-fatal', MessageFrame, (payload) => {
        this.connected = false;
        this.reconnectingState = false;
        this.events.emit(TransportEvent.Fatal({ message: payload.message }));
      });

      // The connection ended with tmux's own reason. A deliberate detach is
      // NOT a failure: clearing `reconnectingState` here is what stops the
      // adapter presenting it as a retry.
      await on('tmux-detached', DetachedEvent, (payload) => {
        this.connected = false;
        this.reconnectingState = false;
        this.events.emit(TransportEvent.Detached({ reason: payload.reason ?? null }));
      });

      // Errors (emitted by monitor.rs on connection failure), a bare message.
      await on('tmux-error', Schema.String, (message) => {
        this.events.emit(TransportEvent.Error({ message }));

        // A dropped connection, a failed first attempt and a failed retry
        // all leave the adapter retrying.
        this.connected = false;
        this.reconnectingState = true;
        this.events.emit(TransportEvent.Reconnection({ reconnecting: true }));
      });

      this.connected = true;

      this.events.emit(TransportEvent.ConnectionInfo({ defaultShell: 'bash', readOnly: false }));

      // Action tracing (docs/TELEMETRY.md): ask the local backend whether it is
      // recording; only then ship our events to it over IPC.
      tracer.setServerEnabled(!!(await invoke<boolean>('trace_enabled')));
      tracer.setSink((events) => {
        void import('@tauri-apps/api/core').then(({ invoke: inv }) =>
          inv('record_trace', { events }).catch(() => {}),
        );
      });
      // The native Debug menu can flip the switch behind the frontend's
      // back; gui.rs calls this after a toggle so the client tracer starts
      // or stops shipping in the same beat as the backend.
      (window as { tmuxyTraceSync?: (on: boolean) => void }).tmuxyTraceSync = (on) =>
        tracer.setServerEnabled(on);

      // Backfill keybindings: the backend's first `tmux-keybindings` event
      // can fire before this listener is attached (especially on a fresh
      // launch where the WebView is still booting). Without this fetch the
      // prefix indicator stays hidden and prefix/root bindings are empty,
      // so prefix-key and Ctrl+hjkl silently no-op.
      const snapshot = decodeEvent(
        Schema.NullOr(KeyBindings),
        'get_keybindings_snapshot',
      )(await invoke<unknown>('get_keybindings_snapshot'));
      if (snapshot) {
        this.events.emit(TransportEvent.KeyBindings({ keybindings: snapshot }));
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

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');

    // Answered raw: the stream stage decodes and adopts it.
    if (cmd === 'get_initial_state') return invoke<T>(cmd, args);

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
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          const result = await invoke<T>(cmd, args);
          resolveOuter(result);
        } catch (err) {
          rejectOuter(err);
        }
      });
      return outer;
    }

    return invoke(cmd, args);
  }

  /**
   * Read from tmux (see TmuxAdapter.query) — straight to the Tauri command
   * rather than onto `sendQueue`: it is answered in-band on the monitor's
   * connection, so the sessions poll can't delay window ops and needs no
   * ordering from here.
   */
  async query(command: string): Promise<string> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('query_tmux', { command });
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
