/**
 * A tmux control-mode client running against real tmux in an in-browser
 * guest machine, with tmuxy-core (compiled to wasm) reconstructing the state
 * from the stream — the same code the native server runs.
 *
 * This class is everything that does not depend on the machine: the wasm
 * core, the tick/sync timers, `%exit` detection, tracked commands and
 * scrollback captures, the attach-and-sync loop, and a serialized lifecycle.
 * A subclass supplies the machine — how it boots or resets, and how bytes
 * reach the guest (`send`) and come back (`receive`): `V86Engine` over an
 * emulated UART, `CheerpXEngine` over CheerpX's console.
 *
 * The current adapter wires its state/clipboard callbacks via `setSink()`; the
 * engine calls back into whichever sink is currently attached.
 */
import type { PaneContent, ServerStateEncoded } from '../../../../domain/wire';
import {
  CaptureBook,
  EMPTY_STATE,
  GUEST_SETUP,
  loadWasmModule,
  TrackedCommandBook,
  wait,
  type FeedOutput,
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

/** Where the engine forwards reconstructed state + clipboard writes. */
export interface EngineSink {
  onState(state: ServerStateEncoded): void;
  onClipboard(paneId: string, text: string): void;
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

  /** Rolling tail of the stream for cross-chunk %exit detection. */
  private exitTail = '';
  private readonly trackedCommands = new TrackedCommandBook();
  private readonly captureBook = new CaptureBook();
  private lastState: ServerStateEncoded = EMPTY_STATE;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;

  /** The sink for the CURRENTLY-attached adapter (null between stories). */
  protected sink: EngineSink | null = null;
  /** Fired after every successful attach (cold boot or reset). */
  private readyListeners = new Set<() => void>();

  /** Queue a control-mode command (one line, or several) for the guest. */
  abstract send(cmd: string): void;
  /** Bring the machine up and attach; runs inside the lifecycle queue. */
  protected abstract doBoot(initCommands: string[]): Promise<void>;
  /** Give the next adapter a clean start; runs inside the lifecycle queue. */
  protected abstract doReset(initCommands: string[]): Promise<void>;
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

  /** Run a tmux command and resolve with what it printed (see `CaptureBook`):
   *  empty when it fails or tmux does not answer in time. */
  query(command: string): Promise<string> {
    return this.captureBook.capture(command, (cmd) => this.send(cmd));
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
  boot(initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doBoot(initCommands));
  }

  /** A clean start for the next adapter (boots when not booted). Serialized
   *  behind any in-flight boot/reset. */
  reset(initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doReset(initCommands));
  }

  /**
   * Install a FRESH core (loading the wasm module the first time) and start
   * the timers once, so a reused engine starts each story from a clean state
   * (no bleed of panes/windows/sessions/theme from the previous one).
   */
  protected async freshCore(): Promise<void> {
    this.wasmModule ??= await loadWasmModule();
    this.core = new this.wasmModule.WasmTmux('m');
    this.lastState = EMPTY_STATE;
    // Serve inline terminal-image bytes from the CURRENT wasm store (no backend).
    (
      window as unknown as { __tmuxyImageSrc?: (p: string, i: number) => string | undefined }
    ).__tmuxyImageSrc = (paneId, imageId) => this.core?.image_url(paneId, imageId);
    if (this.tickTimer) return;
    // Pane-output updates are debounced by the aggregator; flush them on a timer.
    this.tickTimer = setInterval(() => {
      if (this.core && this.attached) this.emit(this.core.tick());
    }, 50);
    // Periodic re-sync catches state that events don't push mid-lifecycle:
    // window metadata (@tmuxy-window-type for floats/groups/widgets/sidebar)
    // AND pane→window mapping (a break-pane's list-panes can race the move,
    // leaving a float's pane mapped to the old window until the next sync).
    // list-panes responses are matched by format shape and never consume the
    // capture FIFO, so this cannot corrupt in-flight capture-pane replies.
    this.syncTimer = setInterval(() => {
      if (!this.core || !this.attached) return;
      for (const cmd of this.core.initial_sync()) this.send(cmd);
    }, 3000);
  }

  /** Feed a chunk of the control-mode stream the guest wrote. */
  protected receive(chunk: string): void {
    if (!chunk || !this.attached || !this.core) return;
    if (this.captureBook.hasPending()) this.captureBook.scanChunk(chunk);
    this.emit(this.core.feed(chunk));
    // `%exit` ends the control-mode conversation (server died / kill-server /
    // last session closed). Surface it as a fatal so the app can show its
    // non-recoverable status screen — mirroring the native monitor, which
    // reacts to the connection closing. The marker can straddle two chunks,
    // so scan a small rolling window instead of the bare chunk.
    const window_ = this.exitTail + chunk;
    if (/(^|\n)%exit(\s|\r|$)/.test(window_)) {
      this.attached = false;
      this.sink?.onFatal('tmux control-mode connection ended (%exit)');
    }
    this.exitTail = window_.slice(-8);
  }

  /**
   * Settle every in-flight tracked command and scrollback capture, and clear
   * the cross-chunk scanning state. Without this a shared-engine reset leaks
   * the previous story's correlation state into the next one: a stale armed
   * tracker steals the new story's first responses, and a stale capture
   * swallows lines meant for a fresh one.
   */
  protected failInFlight(reason: string): void {
    this.trackedCommands.failAll(reason);
    this.captureBook.failAll();
    this.exitTail = '';
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
      this.send(`refresh-client -C ${GUEST_DEFAULT_COLS}x${GUEST_DEFAULT_ROWS}`);
      for (const cmd of GUEST_SETUP) this.send(cmd);
      for (const cmd of this.core.initial_sync()) this.send(cmd);
      await Promise.race([firstState, wait(timing.attemptMs)]);
    }
    // Init commands only once, after the attach demonstrably works — a resend
    // would duplicate their effects (an extra split-window, say).
    for (const cmd of initCommands) this.send(cmd);
    for (const cb of this.readyListeners) cb();
  }

  /** Re-request the full window/pane list (used after switch-session). */
  resync(): void {
    for (const cmd of this.core?.initial_sync() ?? []) this.send(cmd);
  }

  private emit(out: FeedOutput): void {
    if (!this.core) return;
    for (const [ok, firstLine] of out.responses ?? []) {
      this.trackedCommands.onResponse(ok, firstLine);
    }
    for (const cmd of out.commands) this.send(cmd);
    for (const [paneId, text] of out.clipboard) this.sink?.onClipboard(paneId, text);
    if (out.updates.length === 0) return;
    // KNOWN LIMITATION: chaining the updates via handleStateUpdate is not
    // usable as the emitted state yet — an update computed earlier in a burst
    // carries a pre-select-pane active id, and the appMachine's
    // optimistic-focus/layout-transition heuristics (tuned against
    // server-timed emissions) permanently pin the stale focus. The per-batch
    // snapshot is always internally consistent, which those heuristics assume.
    const snapshot = this.core.snapshot();
    // serde-wasm-bindgen serializes Option::None as `undefined`; the wire
    // schema expects `null`.
    const state: ServerStateEncoded = {
      ...snapshot,
      active_window_id: snapshot.active_window_id ?? null,
      active_pane_id: snapshot.active_pane_id ?? null,
    };
    this.lastState = state;
    this.sink?.onState(state);
    if (state.panes.length > 0 && this.resolveFirstState) {
      this.resolveFirstState();
      this.resolveFirstState = null;
    }
  }

  /**
   * Send a command (or ` ; `-separated command list) and resolve with its real
   * outcome — success, or the first %error line. The command is bracketed
   * between two display-message markers, each its own line, so its replies
   * can be picked out of the FIFO exactly, regardless of what the core sends
   * around it, how many response blocks the command produces, or whether it
   * fails partway (see `TrackedCommandBook`). A timeout is a FAILURE: reporting
   * success for a command that may never have executed commits optimistic
   * state the server doesn't have (silent divergence, the worst outcome);
   * failing rolls the op back visibly and a resync converges the rest.
   */
  sendTracked(cmd: string): Promise<{ ok: boolean; message: string }> {
    return this.trackedCommands.sendTracked(
      cmd,
      (line) => this.send(line),
      () => {
        // Converge whatever DID execute; skip when detached (mid-reset —
        // writing into a rewinding machine corrupts the fresh attach).
        if (this.attached) this.resync();
      },
    );
  }

  destroy(): void {
    this.failInFlight('engine destroyed');
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.tickTimer = null;
    this.syncTimer = null;
    this.sink = null;
    this.booted = false;
    this.attached = false;
    this.core = null;
    this.teardown();
  }
}
