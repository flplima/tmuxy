import {
  TmuxAdapter,
  StateListener,
  ErrorListener,
  ConnectionInfoListener,
  ReconnectionListener,
  KeyBindingsListener,
  ThemeSettingsListener,
  LogListener,
  FatalListener,
  DetachedListener,
  ClipboardListener,
} from './types';
import {
  ClipboardEvent,
  DetachedEvent,
  KeyBindings,
  LogEvent,
  MessageFrame,
  ThemeSettings,
  type LogEntryKind,
  type ServerState,
} from '../domain/wire';
import { Schema } from 'effect';
import { HttpAdapter } from './HttpAdapter';
import { DemoAdapter } from './demo/DemoAdapter';
import { StateStream } from './stateStream';
import { decodeEvent } from './wireDecode';
import { KeyBatcher } from './keyBatching';
import { latencyTracker } from './latencyTracker';
import { tracer } from './tracer';

// ============================================
// Tauri Adapter
// ============================================

export class TauriAdapter implements TmuxAdapter {
  readonly enumeratesSessions = true;
  private connected = false;
  private reconnectingState = false;
  private unlistenFns: (() => void)[] = [];

  private stateListeners = new Set<StateListener>();
  private errorListeners = new Set<ErrorListener>();
  private connectionInfoListeners = new Set<ConnectionInfoListener>();
  private reconnectionListeners = new Set<ReconnectionListener>();
  private keyBindingsListeners = new Set<KeyBindingsListener>();
  private themeSettingsListeners = new Set<ThemeSettingsListener>();
  private logListeners = new Set<LogListener>();
  private fatalListeners = new Set<FatalListener>();
  private detachedListeners = new Set<DetachedListener>();
  private clipboardListeners = new Set<ClipboardListener>();

  /**
   * The state stream: decoding, delta sequencing and the client's copy of the
   * state. With the cached client size below, a dropped/misordered or
   * undecodable delta triggers a get_initial_state refetch instead of
   * diverging. The Tauri event channel has no ring-buffer replay, so this is
   * the only recovery path on that transport.
   */
  private readonly stream = new StateStream();
  /** Delta seq of the most recent applied update, for the trace `apply` event. */
  private lastAppliedSeq: number | null = null;
  private lastCols = 0;
  private lastRows = 0;
  private resyncing = false;

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

      // State updates (full or delta), decoded and sequenced by the stream.
      const unlistenState = await listen<unknown>('tmux-state-update', (event) => {
        const step = this.stream.receive(event.payload);
        if (step._tag === 'resync') {
          void this.resyncFullState();
          return;
        }
        if (step._tag === 'apply') {
          this.lastAppliedSeq = step.seq;
          this.notifyStateChange(step.state);
        }

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
          this.notifyReconnection(false);
        }
      });
      this.unlistenFns.push(unlistenState);

      await on('tmux-keybindings', KeyBindings, (keybindings) =>
        this.notifyKeyBindings(keybindings),
      );

      // Theme + appearance, re-pushed after the config is sourced
      await on('tmux-theme-settings', ThemeSettings, (settings) =>
        this.notifyThemeSettings(settings),
      );

      // Streaming connection-time progress (each command + output)
      await on('tmux-log', LogEvent, (payload) => this.notifyLog(payload.kind, payload.message));

      // OSC 52 clipboard write requests from terminal applications, forwarded
      // by monitor.rs. Mirrored into the system clipboard by the tmux actor.
      // Without this the desktop app silently drops every terminal clipboard
      // write (HttpAdapter has the same listener).
      await on('tmux-clipboard', ClipboardEvent, (payload) =>
        this.notifyClipboard(payload.pane_id, payload.text),
      );

      // Backend gave up reconnecting — terminal state, no further events.
      await on('tmux-fatal', MessageFrame, (payload) => {
        this.connected = false;
        this.reconnectingState = false;
        this.notifyFatal(payload.message);
      });

      // The connection ended with tmux's own reason. A deliberate detach is
      // NOT a failure: clearing `reconnectingState` here is what stops the
      // adapter presenting it as a retry.
      await on('tmux-detached', DetachedEvent, (payload) => {
        this.connected = false;
        this.reconnectingState = false;
        this.notifyDetached(payload.reason ?? null);
      });

      // Errors (emitted by monitor.rs on connection failure), a bare message.
      await on('tmux-error', Schema.String, (message) => {
        this.notifyError(message);

        // A dropped connection, a failed first attempt and a failed retry
        // all leave the adapter retrying.
        this.connected = false;
        this.reconnectingState = true;
        this.notifyReconnection(true);
      });

      this.connected = true;

      this.notifyConnectionInfo('bash');

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
        this.notifyKeyBindings(snapshot);
      }
    } catch (e) {
      this.notifyError('Failed to connect to Tauri');
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
    this.stream.reset();
  }

  // Serial queue for mutating commands so they reach the Tauri executor in
  // issue order. Same rationale as HttpAdapter: tauri::invoke spawns each
  // command as its own task, so two commands have no ordering guarantee on
  // their way to the monitor. A `split-window -h` racing past a
  // `select-window -t @B` would split the previous tab.
  private sendQueue: Promise<void> = Promise.resolve();

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');

    // Cache the client size so a seq-gap resync can refetch get_initial_state.
    if (
      (cmd === 'set_client_size' || cmd === 'get_initial_state') &&
      typeof args?.cols === 'number' &&
      typeof args?.rows === 'number'
    ) {
      this.lastCols = args.cols;
      this.lastRows = args.rows;
    }

    // The answer is decoded and adopted by the stream, so deltas apply to it.
    if (cmd === 'get_initial_state') {
      return this.stream.adopt(await invoke<unknown>(cmd, args)) as T;
    }

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

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onConnectionInfo(listener: ConnectionInfoListener): () => void {
    this.connectionInfoListeners.add(listener);
    return () => this.connectionInfoListeners.delete(listener);
  }

  onReconnection(listener: ReconnectionListener): () => void {
    this.reconnectionListeners.add(listener);
    return () => this.reconnectionListeners.delete(listener);
  }

  onKeyBindings(listener: KeyBindingsListener): () => void {
    this.keyBindingsListeners.add(listener);
    return () => this.keyBindingsListeners.delete(listener);
  }

  onThemeSettings(listener: ThemeSettingsListener): () => void {
    this.themeSettingsListeners.add(listener);
    return () => this.themeSettingsListeners.delete(listener);
  }

  onLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  onFatal(listener: FatalListener): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  onDetached(listener: DetachedListener): () => void {
    this.detachedListeners.add(listener);
    return () => this.detachedListeners.delete(listener);
  }

  onClipboard(listener: ClipboardListener): () => void {
    this.clipboardListeners.add(listener);
    return () => this.clipboardListeners.delete(listener);
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

  private notifyStateChange(state: ServerState) {
    // Closes the oldest outstanding input's round trip and feeds update-rate /
    // stall metrics (Axis-B, see latencyTracker).
    latencyTracker.recordUpdate();
    tracer.event({ layer: 'adapter', name: 'apply', seq: this.lastAppliedSeq ?? undefined });
    this.stateListeners.forEach((listener) => listener(state));
  }

  private notifyLog(kind: LogEntryKind, message: string) {
    this.logListeners.forEach((listener) => listener(kind, message));
  }

  private notifyFatal(message: string) {
    this.fatalListeners.forEach((listener) => listener(message));
  }

  private notifyDetached(reason: string | null) {
    this.detachedListeners.forEach((listener) => listener(reason));
  }

  private notifyError(error: string) {
    this.errorListeners.forEach((listener) => listener(error));
  }

  private notifyConnectionInfo(defaultShell: string) {
    this.connectionInfoListeners.forEach((listener) => listener(defaultShell));
  }

  private notifyReconnection(reconnecting: boolean) {
    this.reconnectionListeners.forEach((listener) => listener(reconnecting));
  }

  async switchSession(newSession: string): Promise<void> {
    // For Tauri, use switch-client to change the tmux session
    await this.invoke<void>('run_tmux_command', { command: `switch-client -t ${newSession}` });
  }

  private notifyKeyBindings(keybindings: KeyBindings) {
    this.keyBindingsListeners.forEach((listener) => listener(keybindings));
  }

  private notifyThemeSettings(settings: ThemeSettings) {
    this.themeSettingsListeners.forEach((listener) => listener(settings));
  }

  private notifyClipboard(paneId: string, text: string) {
    this.clipboardListeners.forEach((listener) => listener(paneId, text));
  }

  /** Refetch a full snapshot after a delta seq gap (see HttpAdapter). */
  private async resyncFullState(): Promise<void> {
    if (this.resyncing) return;
    if (this.lastCols === 0 || this.lastRows === 0) return;
    this.resyncing = true;
    try {
      const state = await this.invoke<ServerState>('get_initial_state', {
        cols: this.lastCols,
        rows: this.lastRows,
      });
      // invoke() already adopted the answer into the stream.
      this.notifyStateChange(state);
    } catch (e) {
      console.error('Delta seq-gap resync failed; awaiting next full snapshot:', e);
    } finally {
      this.resyncing = false;
    }
  }
}

// ============================================
// Factory
// ============================================

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isDemoUrl(): boolean {
  return typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('demo');
}

export function createAdapter(): TmuxAdapter {
  if (isTauri()) {
    return new TauriAdapter();
  }
  if (isDemoUrl()) {
    return new DemoAdapter();
  }
  return new HttpAdapter();
}
