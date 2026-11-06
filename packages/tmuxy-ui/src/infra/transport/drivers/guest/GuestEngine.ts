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
 *
 * The current adapter wires its state/clipboard callbacks via `setSink()`; the
 * engine calls back into whichever sink is currently attached.
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
 * The terminal a guest starts at, and the size every guest story runs unless
 * it asks for another — a plain 80x30, what a terminal is when nobody has
 * resized it. The guest starts at this shape so its first frame is already
 * the size the story expects, rather than resizing under it.
 *
 * `GuestTmuxAdapter` falls back to the same pair, and `V86AppHarness` sizes
 * its box so the app measures back exactly these numbers.
 */
export const GUEST_DEFAULT_COLS = 80;
export const GUEST_DEFAULT_ROWS = 30;

/**
 * Where the page's files land in the guest: v86's 9p share, which the
 * snapshot mounts there, and a CheerpX in-memory device mounted at the same
 * path.
 */
export const GUEST_FILES_DIR = '/mnt';

/** A file the page puts in `GUEST_FILES_DIR`, by its name there. */
export interface GuestFile {
  name: string;
  bytes: Uint8Array;
}

/** The session the guest images start (`scripts/build-v86-snapshot.mjs`). */
const GUEST_SESSION = 'm';

/** How often the core is asked what is due (its own deadlines are finer
 *  than this only for the settling flush, which tolerates it). */
const TICK_MS = 50;

/** How long `waitForOption` waits for the option, and how often it looks. */
const OPTION_WAIT_DEADLINE_MS = 15000;
const OPTION_POLL_MS = 100;

/** Where the engine forwards reconstructed state + clipboard writes. */
export interface EngineSink {
  onState(state: ServerStateEncoded): void;
  onClipboard(paneId: string | null, text: string): void;
  /** A notice for the person (`%message`, a command's printout). */
  onMessage(text: string): void;
  /** A command tmux refused. */
  onError(message: string): void;
  /** The control-mode stream ended (`%exit`) — the tmux server died or the
   *  client was detached. Non-recoverable for this attach. */
  onFatal(message: string): void;
}

/** How patient the attach loop is: a cold machine brings tmux up on its own
 *  schedule, a warm one answers almost at once. */
export interface AttachTiming {
  /** Before the first attempt. */
  settleMs: number;
  /** Between sending the attach line and the sync. */
  attachMs: number;
  /** How long one attempt waits for the first state. */
  attemptMs: number;
  /** When to stop trying. */
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
  /** The session the control client is on. */
  private session = GUEST_SESSION;
  /** The viewport last asked for, which a new window is made at. */
  private clientSize: { cols: number; rows: number } = {
    cols: GUEST_DEFAULT_COLS,
    rows: GUEST_DEFAULT_ROWS,
  };

  /** The sink for the CURRENTLY-attached adapter (null between stories). */
  protected sink: EngineSink | null = null;
  /** Fired after every successful attach (cold boot or reset). */
  private readyListeners = new Set<() => void>();

  /** Queue a control-mode command (one line, or several) for the guest. */
  abstract send(cmd: string): void;
  /** Bring the machine up and attach; runs inside the lifecycle queue. Puts
   *  `files` in the guest's `GUEST_FILES_DIR` before `initCommands` run. */
  protected abstract doBoot(initCommands: string[], files: GuestFile[]): Promise<void>;
  /** Give the next adapter a clean start; runs inside the lifecycle queue.
   *  Puts `files` in `GUEST_FILES_DIR` before `initCommands` run. */
  protected abstract doReset(initCommands: string[], files: GuestFile[]): Promise<void>;
  /** Release the machine. */
  protected abstract teardown(): void;

  isBooted(): boolean {
    return this.booted;
  }

  setSink(sink: EngineSink | null): void {
    this.sink = sink;
  }

  /**
   * Detach a sink, but ONLY if it is still the current one. On a shared
   * engine a story's disconnect can run AFTER the next story already installed
   * its own sink; clearing unconditionally would silence the new story (it
   * renders zero panes forever). Passing the sink to clear makes late cleanup
   * a no-op.
   */
  clearSink(sink: EngineSink): void {
    if (this.sink === sink) this.sink = null;
  }

  /** Subscribe to "attached and synced" — fires after each boot/reset. */
  onReady(cb: () => void): () => void {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  getLastState(): ServerStateEncoded {
    return this.lastState;
  }

  /** Parse raw `capture-pane -p -e` text into cells via the core parser. */
  parseScrollback(text: string, width: number): PaneContent {
    return this.core?.parse_scrollback(text, width) ?? [];
  }

  /**
   * Run `capture-pane -p -e -S start -E end` and resolve with the raw captured
   * text. Client-side copy mode calls this to fetch scrollback history in the
   * fully-in-browser deployment, where there is no HTTP scrollback RPC.
   */
  captureScrollback(paneId: string, start: number, end: number): Promise<string> {
    return this.query(`capture-pane -t ${paneId} -p -e -S ${start} -E ${end}`);
  }

  /** Where the routing policy every transport applies sends `command`
   *  (tmuxy-core `command_router`); a query reads, or is refused. */
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

  /** Run a routed command and resolve with its reply (the core answers a
   *  command tmux never does with a failure of its own). */
  ask(command: string): Promise<Reply> {
    if (!this.core) return Promise.resolve({ output: '', error: 'the guest is not running' });
    const { id, reply } = this.replies.open();
    this.emit(this.core.run(command, id));
    return reply;
  }

  /** Run a routed command nobody waits on; tmux's refusal reaches the sink. */
  run(command: string): void {
    if (this.core) this.emit(this.core.run(command));
  }

  /** Run a tmux command and resolve with what it printed: empty when it
   *  fails. The engine's own reads, outside the routing a client's get. */
  async query(command: string): Promise<string> {
    const reply = await this.ask(command);
    return reply.error === null ? reply.output : '';
  }

  /**
   * Wait (at most `OPTION_WAIT_DEADLINE_MS`) until the global tmux option
   * `option` is set, then until the state it leaves has reached the core: a
   * re-sync, and a round trip behind it. What the init commands start can
   * outlive them (a shell line typed into a pane runs on the shell's time),
   * and an option is how it says it is done: a control client blocked in
   * `wait-for` could be released by nothing but the signal.
   */
  async waitForOption(option: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < OPTION_WAIT_DEADLINE_MS) {
      if ((await this.query(`show-options -gqv ${option}`)).trim()) break;
      await wait(OPTION_POLL_MS);
    }
    await this.synced();
  }

  /** Size every window to the client's `cols`x`rows`, as tmux lists them. */
  setClientSize(cols: number, rows: number): void {
    this.clientSize = { cols, rows };
    if (this.core) this.emit(this.core.setClientSize(cols, rows));
  }

  /** `setClientSize`, resolving once the state at that size has reached
   *  the core. */
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

  /** A re-sync, and a round trip behind it: everything tmux has done so far
   *  is in the core's state when it resolves. */
  private async synced(): Promise<void> {
    this.resync();
    await this.query('display-message -p synced');
  }

  /**
   * Serializes boot/reset so overlapping lifecycle calls can't run two
   * machine transitions at once. A story switch on a shared engine calls the
   * next adapter's `connect()` (→ reset) before the previous story's
   * boot/reset promise has settled; without this queue both would drive the
   * machine and the core swap concurrently and corrupt it. Errors are
   * swallowed on the chain (so one bad transition doesn't wedge all future
   * ones) but still propagate to the specific caller that awaited them.
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(op, op);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  /** Cold boot, then attach + sync + run `initCommands`. Serialized. */
  boot(initCommands: string[], files: GuestFile[] = []): Promise<void> {
    return this.enqueue(() => this.doBoot(initCommands, files));
  }

  /** A clean start for the next adapter (boots when not booted). Serialized
   *  behind any in-flight boot/reset. */
  reset(initCommands: string[], files: GuestFile[] = []): Promise<void> {
    return this.enqueue(() => this.doReset(initCommands, files));
  }

  /**
   * Install a FRESH core (loading the wasm module the first time) and start
   * the timer once, so a reused engine starts each story from a clean state
   * (no bleed of panes/windows/sessions/theme from the previous one).
   */
  protected async freshCore(): Promise<void> {
    this.wasmModule ??= await loadWasmModule();
    this.session = GUEST_SESSION;
    this.core = new this.wasmModule.WasmTmux(this.session);
    this.lastState = EMPTY_STATE;
    // Serve inline terminal-image bytes from the CURRENT wasm store (no backend).
    (
      window as unknown as { __tmuxyImageSrc?: (p: string, i: number) => string | undefined }
    ).__tmuxyImageSrc = (paneId, imageId) => this.core?.image_url(paneId, imageId);
    if (this.tickTimer) return;
    // The core's own timers: the settling flush, the metadata re-list after
    // output, the copy-mode poll and idle heartbeat, replies that time out.
    this.tickTimer = setInterval(() => {
      if (this.core && this.attached) this.emit(this.core.tick());
    }, TICK_MS);
  }

  /** Feed a chunk of the control-mode stream the guest wrote. */
  protected receive(chunk: string): void {
    if (!chunk || !this.attached || !this.core) return;
    this.emit(this.core.feed(chunk));
  }

  /** Settle every reply still awaited: a shared-engine reset would
   *  otherwise leave the previous story's callers waiting on a core that is
   *  gone. */
  protected failInFlight(reason: string): void {
    this.replies.failAll(reason);
  }

  /**
   * Attach a control client (`attachLine`, when the machine does not attach
   * one itself), size it, full-sync, then run init commands; resolves once the
   * first real state arrives (bounded by `timing.deadlineMs`).
   */
  protected async start(
    initCommands: string[],
    attachLine: string | null,
    timing: AttachTiming,
  ): Promise<void> {
    if (!this.core) return;
    await wait(timing.settleMs);
    this.attached = true;
    // Poll to a DEADLINE rather than a fixed attempt count: a cold machine
    // brings tmux up on its own schedule, so any fixed budget either flakes on
    // a slow boot or wastes time on a fast one. Loop until real panes arrive
    // or the deadline elapses; the app's connect() awaits this, so it resolves
    // only once the session is genuinely synced.
    //
    // Two phases share the loop: while NO state has arrived the control client
    // isn't up, so (re)send the attach line — a stray copy lands on the shell
    // prompt (errors harmlessly) or in control-mode stdin (an unknown-command
    // %error), both tolerated by the parser, and recovers a byte-drop right
    // after a restore. Once any state has arrived the connection is live, so
    // stop re-attaching and just re-request the pane list until it's populated.
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
    // Init commands only once, after the attach demonstrably works — a resend
    // would duplicate their effects (an extra split-window, say).
    for (const cmd of initCommands) this.send(cmd);
    for (const cb of this.readyListeners) cb();
  }

  /** Re-request the full window/pane list. */
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
      // `%exit` ends the control-mode conversation (server died /
      // kill-server / last session closed): non-recoverable for this attach.
      this.attached = false;
      const reason = out.ended.reason ? ` (${out.ended.reason})` : '';
      this.sink?.onFatal(`tmux control-mode connection ended${reason}`);
      return;
    }
    if (!out.changed) return;
    // KNOWN LIMITATION: chaining the updates via handleStateUpdate is not
    // usable as the emitted state yet — an update computed earlier in a burst
    // carries a pre-select-pane active id, and the appMachine's
    // optimistic-focus/layout-transition heuristics (tuned against
    // server-timed emissions) permanently pin the stale focus. The per-batch
    // snapshot is always internally consistent, which those heuristics assume.
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
