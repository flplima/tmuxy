/**
 * A tmux control-mode client running against real tmux in an in-browser
 * guest machine, with tmuxy-core (compiled to wasm) reconstructing the state
 * from the stream — the same code the native server runs.
 *
 * This class is everything that does not depend on the machine: the wasm
 * core (which does what the native monitor does — attach settings, routing,
 * replies, re-list timers, window sizing, `%exit`), the timer that drives it,
 * the attach-and-sync loop, and a serialized lifecycle.
 * A subclass supplies the machine — how it boots or resets, and how bytes
 * reach the guest (`send`) and come back (`receive`): `V86Engine` over an
 * emulated UART, `CheerpXEngine` over CheerpX's console.
 */
import type { ServerStateEncoded } from '../../../../domain/wire';
import type { PaneContent } from '../../../../domain/wireCells';
import {
  EMPTY_STATE,
  loadWasmModule,
  ReplyBook,
  wait,
  type Feed,
  type Reply,
  type Routed,
  type WasmCore,
  type WasmModule,
} from './controlMode';

/**
 * The size every guest story runs at unless it asks for another, so the first
 * frame is already the size the story expects. `V86AppHarness` sizes its box
 * so the app measures back exactly these numbers.
 */
export const GUEST_DEFAULT_COLS = 80;
export const GUEST_DEFAULT_ROWS = 30;

/**
 * Where the page's files land in the guest: v86's 9p share, which the
 * snapshot mounts there, and a CheerpX in-memory device mounted at the same
 * path.
 */
export const GUEST_FILES_DIR = '/mnt';

export interface GuestFile {
  name: string;
  bytes: Uint8Array;
}

/** The session the guest images start (`scripts/build-v86-snapshot.mjs`). */
const GUEST_SESSION = 'm';

/** How often the core is asked what is due (its own deadlines are finer
 *  than this only for the settling flush, which tolerates it). */
const TICK_MS = 50;

const OPTION_WAIT_DEADLINE_MS = 15000;
const OPTION_POLL_MS = 100;

export interface EngineSink {
  onState(state: ServerStateEncoded): void;
  onClipboard(paneId: string | null, text: string): void;
  /** A notice for the person (`%message`, a command's printout). */
  onMessage(text: string): void;
  /** A command tmux refused. */
  onError(message: string): void;
  /** The control-mode stream ended (`%exit`): the tmux server died or the
   *  client was detached. Non-recoverable for this attach. */
  onFatal(message: string): void;
}

/** How patient the attach loop is: a cold machine brings tmux up on its own
 *  schedule, a warm one answers almost at once. */
export interface AttachTiming {
  settleMs: number;
  /** Between sending the attach line and the sync. */
  attachMs: number;
  /** How long one attempt waits for the first state. */
  attemptMs: number;
  deadlineMs: number;
}

export abstract class GuestEngine {
  private wasmModule: WasmModule | null = null;
  private core: WasmCore | null = null;
  protected booted = false;
  /** Whether received bytes are fed to the core (off while a machine rewinds). */
  protected attached = false;

  private readonly replies = new ReplyBook();
  private lastState: ServerStateEncoded = EMPTY_STATE;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;
  private session = GUEST_SESSION;
  /** The viewport last asked for, which a new window is made at. */
  private clientSize: { cols: number; rows: number } = {
    cols: GUEST_DEFAULT_COLS,
    rows: GUEST_DEFAULT_ROWS,
  };

  protected sink: EngineSink | null = null;
  private readyListeners = new Set<() => void>();

  /** Queue a control-mode command (one line, or several) for the guest. */
  abstract send(cmd: string): void;
  /** Bring the machine up and attach; runs inside the lifecycle queue. Puts
   *  `files` in the guest's `GUEST_FILES_DIR` before `initCommands` run. */
  protected abstract doBoot(initCommands: string[], files: GuestFile[]): Promise<void>;
  /** Give the next adapter a clean start; runs inside the lifecycle queue.
   *  Puts `files` in `GUEST_FILES_DIR` before `initCommands` run. */
  protected abstract doReset(initCommands: string[], files: GuestFile[]): Promise<void>;
  protected abstract teardown(): void;

  isBooted(): boolean {
    return this.booted;
  }

  setSink(sink: EngineSink | null): void {
    this.sink = sink;
  }

  /**
   * On a shared engine a story's disconnect can run after the next story
   * installed its own sink; clearing that one would silence the new story.
   */
  clearSink(sink: EngineSink): void {
    if (this.sink === sink) this.sink = null;
  }

  /** Fires after each boot/reset, once attached and synced. */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  getLastState(): ServerStateEncoded {
    return this.lastState;
  }

  parseScrollback(text: string, width: number): PaneContent {
    return this.core?.parse_scrollback(text, width) ?? [];
  }

  captureScrollback(paneId: string, start: number, end: number): Promise<string> {
    return this.query(`capture-pane -t ${paneId} -p -e -S ${start} -E ${end}`);
  }

  /** The routing policy every transport applies (tmuxy-core `command_router`). */
  route(command: string, kind: 'command' | 'query'): Routed {
    if (!this.wasmModule) return { blocked: 'the guest is not running' };
    return kind === 'query'
      ? this.wasmModule.routeQuery(command)
      : this.wasmModule.routeCommand(
          command,
          this.session,
          this.clientSize.cols,
          this.clientSize.rows,
        );
  }

  /**
   * Whether the core reports tmux's refusal of a routed `command`
   * (tmuxy-core `command_reports_failure`): keystrokes are the one kind it
   * does not.
   */
  reportsFailure(command: string): boolean {
    return this.wasmModule?.reportsFailure(command) ?? true;
  }

  /** The core answers a command tmux never does with a failure of its own. */
  ask(command: string): Promise<Reply> {
    if (!this.core) return Promise.resolve({ output: '', error: 'the guest is not running' });
    const { id, reply } = this.replies.open();
    this.emit(this.core.run(command, id));
    return reply;
  }

  /** tmux's refusal reaches the sink. */
  run(command: string): void {
    if (this.core) this.emit(this.core.run(command));
  }

  /** The engine's own reads, outside the routing a client's get: empty when
   *  the command fails. */
  async query(command: string): Promise<string> {
    const reply = await this.ask(command);
    return reply.error === null ? reply.output : '';
  }

  /**
   * What the init commands start can outlive them (a shell line typed into a
   * pane runs on the shell's time), and an option is how it says it is done:
   * a control client blocked in `wait-for` could be released by nothing but
   * the signal.
   */
  async waitForOption(option: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < OPTION_WAIT_DEADLINE_MS) {
      if ((await this.query(`show-options -gqv ${option}`)).trim()) break;
      await wait(OPTION_POLL_MS);
    }
    await this.synced();
  }

  setClientSize(cols: number, rows: number): void {
    this.clientSize = { cols, rows };
    if (this.core) this.emit(this.core.setClientSize(cols, rows));
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.setClientSize(cols, rows);
    await this.synced();
  }

  /** Switch the control client to `session`; a switch tmux refuses leaves
   *  the client, and the core, on the session it was on. */
  async switchSession(session: string): Promise<Reply> {
    const before = this.session;
    this.session = session;
    this.core?.expectSession(session);
    const reply = await this.ask(`switch-client -t ${session}`);
    if (reply.error !== null) {
      this.session = before;
      this.core?.expectSession(before);
    }
    this.resync();
    return reply;
  }

  /** tmux answers in order, so once the round trip behind the re-sync is
   *  answered, everything tmux has done so far is in the core's state. */
  private async synced(): Promise<void> {
    this.resync();
    await this.query('display-message -p synced');
  }

  /**
   * A story switch on a shared engine calls the next adapter's `connect()`
   * (a reset) before the previous story's boot/reset has settled; the queue
   * keeps the two from driving the machine at once. A failed transition
   * rejects its own caller only.
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(op, op);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  boot(initCommands: string[], files: GuestFile[] = []): Promise<void> {
    return this.enqueue(() => this.doBoot(initCommands, files));
  }

  reset(initCommands: string[], files: GuestFile[] = []): Promise<void> {
    return this.enqueue(() => this.doReset(initCommands, files));
  }

  protected async freshCore(): Promise<void> {
    this.wasmModule ??= await loadWasmModule();
    this.session = GUEST_SESSION;
    this.core = new this.wasmModule.WasmTmux(this.session);
    this.lastState = EMPTY_STATE;
    // Inline terminal images are served from the current wasm store: there
    // is no backend.
    (
      window as unknown as { __tmuxyImageSrc?: (p: string, i: number) => string | undefined }
    ).__tmuxyImageSrc = (paneId, imageId) => this.core?.image_url(paneId, imageId);
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      if (this.core && this.attached) this.emit(this.core.tick());
    }, TICK_MS);
  }

  protected receive(chunk: string): void {
    if (!chunk || !this.attached || !this.core) return;
    this.emit(this.core.feed(chunk));
  }

  /** A shared-engine reset would otherwise leave the previous story's
   *  callers waiting on a core that is gone. */
  protected failInFlight(reason: string): void {
    this.replies.failAll(reason);
  }

  /** `attachLine` is null when the machine attaches a client itself. */
  protected async start(
    initCommands: string[],
    attachLine: string | null,
    timing: AttachTiming,
  ): Promise<void> {
    if (!this.core) return;
    await wait(timing.settleMs);
    this.attached = true;
    // To a deadline, not an attempt count: a cold machine brings tmux up on
    // its own schedule. Until any state arrives the attach line is re-sent,
    // which recovers a byte dropped right after a restore; a stray copy lands
    // on the shell prompt or as an unknown-command `%error`, both harmless.
    const t0 = Date.now();
    while (this.lastState.panes.length === 0 && Date.now() - t0 < timing.deadlineMs) {
      const firstState = new Promise<void>((r) => (this.resolveFirstState = r));
      const connectionUp = this.lastState.windows.length > 0;
      if (!connectionUp && attachLine) {
        this.send(attachLine);
        await wait(timing.attachMs);
      }
      const { cols, rows } = this.clientSize;
      for (const cmd of this.core.attach(cols, rows)) this.send(cmd);
      this.emit(this.core.setClientSize(cols, rows));
      await Promise.race([firstState, wait(timing.attemptMs)]);
    }
    // Once, after the attach works: a resend would duplicate their effects.
    for (const cmd of initCommands) this.send(cmd);
    for (const cb of this.readyListeners) cb();
  }

  resync(): void {
    for (const cmd of this.core?.resync() ?? []) this.send(cmd);
  }

  private emit(out: Feed): void {
    if (!this.core) return;
    for (const cmd of out.commands) this.send(cmd);
    for (const { id, output, error } of out.replies) this.replies.resolve(id, { output, error });
    for (const { paneId, text } of out.clipboard) this.sink?.onClipboard(paneId, text);
    for (const text of out.messages) this.sink?.onMessage(text);
    for (const message of out.errors) this.sink?.onError(message);
    if (out.ended) {
      this.attached = false;
      const reason = out.ended.reason ? ` (${out.ended.reason})` : '';
      this.sink?.onFatal(`tmux control-mode connection ended${reason}`);
      return;
    }
    if (!out.changed) return;
    const state = this.core.snapshot();
    this.lastState = state;
    this.sink?.onState(state);
    if (state.panes.length > 0 && this.resolveFirstState) {
      this.resolveFirstState();
      this.resolveFirstState = null;
    }
  }

  destroy(): void {
    this.failInFlight('engine destroyed');
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.sink = null;
    this.booted = false;
    this.attached = false;
    this.core = null;
    this.teardown();
  }
}
