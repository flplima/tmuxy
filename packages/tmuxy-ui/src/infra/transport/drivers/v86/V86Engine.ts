/**
 * The low-level v86 + tmuxy-wasm machinery, decoupled from the `TmuxAdapter`
 * facade so it can be either owned by a single adapter (isolated, default) or
 * shared as a process-wide singleton across many stories (opt-in).
 *
 * It owns exactly one v86 emulator, one persistent serial pump, one paced
 * writer, and the periodic tick/sync timers. The tmuxy-wasm core is swappable:
 * on `reset()` the engine restores the pinned snapshot and installs a FRESH core,
 * so a reused instance starts each story from an identical clean state (no bleed
 * of panes/windows/sessions/theme from the previous story).
 *
 * The current adapter wires its state/clipboard callbacks via `setSink()`; the
 * engine calls back into whichever sink is currently attached.
 */

/**
 * The terminal the guest boots at, and the size every v86 story runs unless it
 * asks for another — a plain 80x30, what a terminal is when nobody has resized
 * it. The guest starts at this shape so the first frame after a snapshot
 * restore is already the size the story expects, rather than resizing under it.
 *
 * `V86TmuxAdapter` falls back to the same pair, and `V86AppHarness` sizes its
 * box so the app measures back exactly these numbers.
 */
export const V86_DEFAULT_COLS = 80;
export const V86_DEFAULT_ROWS = 30;
import type { PaneContent, ServerStateEncoded } from '../../../../domain/wire';
import {
  ATTACH,
  CaptureBook,
  createDetachedScreen,
  createV86Emulator,
  EMPTY_STATE,
  encodeUtf8SerialBytes,
  fetchGuestSnapshot,
  GUEST_SETUP,
  loadWasmModule,
  TrackedCommandBook,
  wait,
  type FeedOutput,
  type V86Emulator,
  type WasmCore,
  type WasmModule,
} from './v86Guest';

/** Where the engine forwards reconstructed state + clipboard writes. */
export interface EngineSink {
  onState(state: ServerStateEncoded): void;
  onClipboard(paneId: string, text: string): void;
  /** The control-mode stream ended (`%exit`) — the tmux server died or the
   *  client was detached. Non-recoverable for this attach. */
  onFatal(message: string): void;
}

export class V86Engine {
  private emu: V86Emulator | null = null;
  private wasmModule: WasmModule | null = null;
  private core: WasmCore | null = null;
  private snapshotBytes: ArrayBuffer | null = null;
  private booted = false;

  private byteBuf = '';
  private writing = false;
  /** Rolling tail of the serial stream for cross-chunk %exit detection. */
  private exitTail = '';
  private readonly trackedCommands = new TrackedCommandBook();
  private readonly captureBook = new CaptureBook();
  private attached = false;
  private lastState: ServerStateEncoded = EMPTY_STATE;
  private readonly decoder = new TextDecoder();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;

  /** The sink for the CURRENTLY-attached adapter (null between stories). */
  private sink: EngineSink | null = null;

  /**
   * The guest's VGA text console, rendered by v86's own ScreenAdapter: a
   * detached element the emulator paints into (DOM rows of coloured spans in
   * text mode). Nothing in the app uses it — it exists so story tooling can
   * show the RAW tmux TUI (a second, read-only tmux client on /dev/tty1) next
   * to the tmuxy rendering. See stories/vgaMirror.ts. Painting is paused until
   * a viewer asks for it, so an unused screen costs nothing per frame.
   */
  private readonly screen: HTMLElement = createDetachedScreen();
  /** Fired after every successful attach (cold boot or snapshot reset). */
  private readyListeners = new Set<() => void>();

  isBooted(): boolean {
    return this.booted;
  }

  setSink(sink: EngineSink | null): void {
    this.sink = sink;
  }

  /**
   * Detach a sink, but ONLY if it is still the current one. On the shared
   * engine a story's disconnect can run AFTER the next story already installed
   * its own sink; clearing unconditionally would silence the new story (it
   * renders zero panes forever). Passing the sink to clear makes late cleanup
   * a no-op.
   */
  clearSink(sink: EngineSink): void {
    if (this.sink === sink) this.sink = null;
  }

  /** The VGA console element (see `screen`); reparent it to display it. */
  getScreen(): HTMLElement {
    return this.screen;
  }

  /** Start / stop painting the VGA console. */
  setScreenPainting(on: boolean): void {
    const adapter = this.emu?.screen_adapter;
    if (!adapter) return;
    if (on) adapter.continue();
    else adapter.pause();
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
   * fully-in-browser (v86) deployment, where there is no HTTP scrollback RPC.
   *
   * The capture is bracketed by two unique `display-message` markers so its
   * lines can be picked out of the control-mode stream regardless of what else
   * interleaves. Commands are streamed to the guest in order, so at most one
   * capture is collecting at a time. Falls back to empty text on timeout.
   */
  captureScrollback(paneId: string, start: number, end: number): Promise<string> {
    return this.captureBook.captureScrollback(paneId, start, end, (cmd) => this.send(cmd));
  }

  /**
   * Serializes boot/reset so overlapping lifecycle calls can't run two
   * emulator restores at once. A story switch on the shared engine calls the
   * next adapter's `connect()` (→ reset) before the previous story's
   * boot/reset promise has settled; without this queue both would drive
   * `restore_state`/core-swap concurrently and corrupt the machine. Errors are
   * swallowed on the chain (so one bad transition doesn't wedge all future
   * ones) but still propagate to the specific caller that awaited them.
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(op, op);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  /** Cold boot: load wasm, create the emulator, register the persistent serial
   *  pump + timers, then attach + sync + run `initCommands`. Serialized. */
  boot(initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doBoot(initCommands));
  }

  /** Reuse path: restore the pinned snapshot, install a fresh core, re-attach.
   *  Serialized behind any in-flight boot/reset. */
  reset(initCommands: string[]): Promise<void> {
    return this.enqueue(() => this.doReset(initCommands));
  }

  private async doBoot(initCommands: string[]): Promise<void> {
    const wasm = await loadWasmModule();
    this.wasmModule = wasm;
    this.core = new wasm.WasmTmux('m');

    // Start the snapshot fetch now so it overlaps machine init.
    const snapshotBytes = this.fetchSnapshot();
    const { emu, loaded } = await createV86Emulator(this.screen);
    this.emu = emu;

    // Serve inline terminal-image bytes from the CURRENT wasm store (no backend).
    (
      window as unknown as { __tmuxyImageSrc?: (p: string, i: number) => string | undefined }
    ).__tmuxyImageSrc = (paneId, imageId) => this.core?.image_url(paneId, imageId);
    // Throughput: v86 emits serial one byte at a time. Coalesce a burst into a
    // single feed() on a short timer instead of one wasm call per byte. Reads the
    // CURRENT core/attached flag dynamically so it survives a core swap on reset.
    let serialBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const chunk = serialBuf;
      serialBuf = '';
      if (!chunk || !this.attached || !this.core) return;
      if (this.captureBook.hasPending()) this.captureBook.scanChunk(chunk);
      this.emit(this.core.feed(chunk));
      // `%exit` ends the control-mode conversation (server died / kill-server /
      // last session closed). Surface it as a fatal so the app can show its
      // non-recoverable status screen — mirroring the native monitor, which
      // reacts to the connection closing. The marker can straddle two serial
      // chunks, so scan a small rolling window instead of the bare chunk.
      const window_ = this.exitTail + chunk;
      if (/(^|\n)%exit(\s|\r|$)/.test(window_)) {
        this.attached = false;
        this.sink?.onFatal('tmux control-mode connection ended (%exit)');
      }
      this.exitTail = window_.slice(-8);
    };
    this.emu.add_listener('serial0-output-byte', (byte: number) => {
      serialBuf += this.decoder.decode(new Uint8Array([byte]), { stream: true });
      if (flushTimer === null) flushTimer = setTimeout(flush, 8);
    });

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
      if (!this.core || !this.emu || !this.attached) return;
      for (const cmd of this.core.initial_sync()) this.send(cmd);
    }, 3000);

    this.booted = true;

    // Wait for the machine to finish initializing, then restore the snapshot and
    // start the CPU from it (restore_state consumes the buffer, so hand it a
    // fresh copy and keep the cache for reset()). The restore itself is quick
    // (~2s), but the guest resumes a few seconds shy of ready — the snapshot is
    // captured mid-init, so on resume it finishes bringing tmux up — so this
    // still uses the patient (cold) start() budget, not the warm one.
    await loaded;
    await emu.restore_state((await snapshotBytes).slice(0));
    await emu.run();
    await this.start(initCommands, false);
  }

  /** Fetch the machine snapshot (cached — reset() reuses the bytes). */
  private async fetchSnapshot(): Promise<ArrayBuffer> {
    if (this.snapshotBytes) return this.snapshotBytes;
    const bytes = await fetchGuestSnapshot();
    this.snapshotBytes = bytes;
    return bytes;
  }

  /**
   * Settle every in-flight tracked command and scrollback capture, and clear
   * the cross-chunk scanning state. Without this a shared-engine reset leaks
   * the previous story's correlation state into the next one: a stale armed
   * tracker steals the new story's first responses, and a stale capture
   * swallows lines meant for a fresh one.
   */
  private failInFlight(reason: string): void {
    this.trackedCommands.failAll(reason);
    this.captureBook.failAll();
    this.exitTail = '';
  }

  private async doReset(initCommands: string[]): Promise<void> {
    // Call doBoot directly (not boot) — we're already inside the lifecycle
    // queue, and re-enqueuing would deadlock behind ourselves.
    if (!this.emu || !this.wasmModule) return this.doBoot(initCommands);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.byteBuf = '';
    this.failInFlight('engine reset');
    const bytes = await this.fetchSnapshot();
    // restore_state consumes the buffer; hand it a fresh copy each reset.
    await this.emu.restore_state(bytes.slice(0));
    // Fresh core discards all accumulated state from the previous story.
    this.core = new this.wasmModule.WasmTmux('m');
    this.lastState = EMPTY_STATE;
    await this.start(initCommands, true);
  }

  /** Attach a control client, size it, full-sync, then run init commands. Shared
   *  by boot() and reset(); each call awaits the first real state (bounded).
   *  `warm` (reset path) uses shorter settle waits — the machine is already
   *  running and just rewound, so it accepts the attach much sooner than a cold
   *  boot that must finish bringing tmux up. */
  private async start(initCommands: string[], warm: boolean): Promise<void> {
    if (!this.emu || !this.core) return;
    await wait(warm ? 400 : 1500);
    // Poll to a DEADLINE rather than a fixed attempt count: a cold boot brings
    // tmux up on its own schedule (the guest cold-boots the kernel, then init
    // starts the server — tens of seconds, and variable), so any fixed budget
    // either flakes on a slow boot or wastes time on a fast one. Loop until real
    // panes arrive or the deadline elapses; the app's connect() awaits this, so
    // it resolves only once the session is genuinely synced.
    //
    // Two phases share the loop: while NO state has arrived the control client
    // isn't up, so (re)send the attach line — a stray copy lands on the shell
    // prompt (errors harmlessly) or in control-mode stdin (an unknown-command
    // %error), both tolerated by the parser, and recovers a UART byte-drop right
    // after restore. Once any state has arrived the connection is live, so stop
    // re-attaching and just re-request the pane list until it's populated.
    const deadlineMs = warm ? 20000 : 75000;
    const t0 = Date.now();
    while (this.lastState.panes.length === 0 && Date.now() - t0 < deadlineMs) {
      const firstState = new Promise<void>((r) => (this.resolveFirstState = r));
      const connectionUp = this.lastState.panes.length > 0 || this.lastState.windows.length > 0;
      if (!connectionUp) {
        this.attached = true;
        this.send(ATTACH);
        await wait(warm ? 500 : 1000);
      }
      this.send(`refresh-client -C ${V86_DEFAULT_COLS}x${V86_DEFAULT_ROWS}`);
      for (const cmd of GUEST_SETUP) this.send(cmd);
      for (const cmd of this.core.initial_sync()) this.send(cmd);
      await Promise.race([firstState, wait(warm ? 2000 : 4000)]);
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
    if (!this.core || !this.emu) return;
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

  /** Queue a control-mode command; streamed to the guest at the paced rate. */
  send(cmd: string): void {
    this.byteBuf += encodeUtf8SerialBytes(cmd);
    this.drainQueue();
  }

  // Stream pending bytes to the guest UART in chunks, paced under the rate the
  // guest drains them. v86's UART holds received bytes in an unbounded queue
  // and keeps the interrupt raised until the guest has read them all, so no
  // chunk size overruns it; what bounds the rate is the guest itself, which
  // reads ~45 KB/s (1,500 marker commands — 46 KB — all answered in order, at
  // every pacing up to 128 KB/s). Staying under that keeps the kernel's tty
  // buffer from filling behind a burst. The pace used to be 8 bytes/4 ms,
  // 2 KB/s, out of a worry about a 16-byte FIFO that this UART does not have:
  // a burst of splits — each a ~600-byte list-panes plus captures — queued
  // seconds of backlog, keystrokes waited behind it, and tracked commands
  // timed out before their bytes had been written.
  private static readonly CHUNK_BYTES = 128;
  private static readonly CHUNK_INTERVAL_MS = 4;
  private drainQueue(): void {
    if (this.writing || !this.emu || this.byteBuf.length === 0) return;
    this.writing = true;
    const chunk = this.byteBuf.slice(0, V86Engine.CHUNK_BYTES);
    this.byteBuf = this.byteBuf.slice(chunk.length);
    this.emu.serial0_send(chunk);
    setTimeout(() => {
      this.writing = false;
      this.drainQueue();
    }, V86Engine.CHUNK_INTERVAL_MS);
  }

  destroy(): void {
    this.failInFlight('engine destroyed');
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.tickTimer = null;
    this.syncTimer = null;
    this.sink = null;
    this.booted = false;
    this.emu?.destroy?.().catch(() => {});
    this.emu = null;
    this.core = null;
  }
}

/** Process-wide singleton for opt-in sharing across stories. */
let sharedEngine: V86Engine | null = null;
export function getSharedEngine(): V86Engine {
  if (!sharedEngine) sharedEngine = new V86Engine();
  return sharedEngine;
}
