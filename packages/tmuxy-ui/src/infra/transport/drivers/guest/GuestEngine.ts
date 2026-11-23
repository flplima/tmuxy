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
 * emulated UART.
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
 * What a start restores: a machine state, fetched from `url`, and the tmux
 * session in it the control client attaches to.
 */
export interface GuestSnapshot {
  url: string;
  session: string;
}

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

/**
 * What a `tmux -CC` client writes the moment it is attached: a DCS
 * introducer, right before the `%begin` of the block answering its own
 * `attach` (tmux's `control_start`). Nothing the guest's shell prints can
 * fake it: the typed line holds no ESC, and once the client runs, a pane's
 * output reaches the stream as `%output` with ESC escaped.
 */
const CONTROL_CLIENT_DCS = '\x1bP1000p';

/** A start waiting for the control client: the stream's last bytes (a DCS
 *  split across two reads) and the start to wake. */
interface Announcement {
  tail: string;
  heard: () => void;
}

/** How patient a start is. Both are deadlines, not a pace: a guest that
 *  answers at once is never kept waiting. */
export interface AttachTiming {
  /** How long one attempt waits for an answer (the control client to
   *  announce itself after the attach line, then the first state after the
   *  core's attach commands) before it is made again. */
  attemptMs: number;
  /** When the start gives up. */
  deadlineMs: number;
}

export abstract class GuestEngine {
  private wasmModule: WasmModule | null = null;
  private core: WasmCore | null = null;
  protected booted = false;
  /** Whether received bytes are fed to the core: off while a machine
   *  rewinds, and until its control client announces itself. */
  protected attached = false;
  private announcement: Announcement | null = null;

  private readonly replies = new ReplyBook();
  private lastState: ServerStateEncoded = EMPTY_STATE;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;
  /** The session the control client is on: the snapshot's, until a switch. */
  private session = '';
  /** The viewport last asked for, which a new window is made at. */
  private clientSize: { cols: number; rows: number } = {
    cols: GUEST_DEFAULT_COLS,
    rows: GUEST_DEFAULT_ROWS,
  };

  protected sink: EngineSink | null = null;
  /** The adapter the machine answers to: the last one to start it. */
  private owner: object | null = null;
  private readyListeners = new Set<() => void>();

  /** Queue a control-mode command (one line, or several) for the guest. */
  abstract send(cmd: string): void;
  /** Bring the machine up from `snapshot` and attach; runs inside the
   *  lifecycle queue. */
  protected abstract doBoot(snapshot: GuestSnapshot, initCommands: string[]): Promise<void>;
  /** Give the next adapter a clean start from `snapshot`; runs inside the
   *  lifecycle queue. */
  protected abstract doReset(snapshot: GuestSnapshot, initCommands: string[]): Promise<void>;
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

  /**
   * Hand the machine to `owner`, before its start. On a shared engine the
   * previous story's app is still unmounting when the next one connects, and
   * what it sends on its way out (its viewport, shrunk to nothing) would
   * resize the next story's tmux; from here on its calls are refused and its
   * sink hears nothing. The start attaches at the size a cold boot does, not
   * at the last one that app asked for.
   */
  claim(owner: object): void {
    this.owner = owner;
    this.sink = null;
    this.clientSize = { cols: GUEST_DEFAULT_COLS, rows: GUEST_DEFAULT_ROWS };
  }

  ownedBy(owner: object): boolean {
    return this.owner === owner;
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

  boot(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doBoot(snapshot, initCommands));
  }

  reset(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doReset(snapshot, initCommands));
  }

  /** A core for a client attached to `session`. */
  protected async freshCore(session: string): Promise<void> {
    this.wasmModule ??= await loadWasmModule();
    this.session = session;
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
    if (!chunk || !this.core) return;
    const waiting = this.announcement;
    const text = waiting ? this.afterAnnouncement(waiting, chunk) : chunk;
    if (!text || !this.attached) return;
    this.emit(this.core.feed(text));
  }

  /**
   * Until its control client is there, the stream is the guest's shell (the
   * typed line's echo, a prompt) and none of it is the core's. Returns what
   * follows the client's announcement: the core is fed from there.
   */
  private afterAnnouncement(waiting: Announcement, chunk: string): string {
    const text = waiting.tail + chunk;
    const at = text.indexOf(CONTROL_CLIENT_DCS);
    if (at < 0) {
      waiting.tail = text.slice(1 - CONTROL_CLIENT_DCS.length);
      return '';
    }
    this.announcement = null;
    this.attached = true;
    waiting.heard();
    return text.slice(at + CONTROL_CLIENT_DCS.length);
  }

  /** A shared-engine reset would otherwise leave the previous story's
   *  callers waiting on a core that is gone. */
  protected failInFlight(reason: string): void {
    this.replies.failAll(reason);
  }

  /**
   * Attach a control client and sync the core to it, each step on the
   * guest's answer: `attachLine` is typed into the guest's shell, the core's
   * attach commands go out once the client it starts announces itself, and
   * the start is done at the first
   * state. An attempt that hears nothing is made again, to a deadline: typing
   * the line again recovers a byte dropped right after a restore. A second line
   * that reaches the client the first one started is refused before any of
   * the core's commands, as a block without the core's markers, which the
   * core ignores.
   */
  protected async start(
    initCommands: string[],
    attachLine: string,
    timing: AttachTiming,
  ): Promise<void> {
    if (!this.core) return;
    const deadline = Date.now() + timing.deadlineMs;
    const attemptMs = () => Math.min(timing.attemptMs, deadline - Date.now());
    try {
      while (this.core && this.lastState.panes.length === 0 && attemptMs() > 0) {
        if (!this.attached) await this.typeAttach(attachLine, attemptMs());
        else await this.syncCore(this.core, attemptMs());
      }
    } finally {
      this.announcement = null;
    }
    if (!this.attached) {
      throw new Error(`the guest's tmux did not answer the attach in ${timing.deadlineMs} ms`);
    }
    // Once, after the attach works: a resend would duplicate their effects.
    for (const cmd of initCommands) this.send(cmd);
    for (const cb of this.readyListeners) cb();
  }

  /** Type the attach line, and wait up to `ms` for the client it starts. */
  private typeAttach(attachLine: string, ms: number): Promise<void> {
    const heard = new Promise<void>((resolve) => {
      this.announcement = { tail: this.announcement?.tail ?? '', heard: resolve };
    });
    this.send(attachLine);
    return Promise.race([heard, wait(ms)]);
  }

  /** Send the core's attach commands, and wait up to `ms` for the first state. */
  private syncCore(core: WasmCore, ms: number): Promise<void> {
    const firstState = new Promise<void>((r) => (this.resolveFirstState = r));
    const { cols, rows } = this.clientSize;
    for (const cmd of core.attach(cols, rows)) this.send(cmd);
    this.emit(core.setClientSize(cols, rows));
    return Promise.race([firstState, wait(ms)]);
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
