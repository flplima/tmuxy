/**
 * The low-level v86 + tmuxy-wasm machinery, decoupled from the `TmuxAdapter`
 * facade so it can be either owned by a single adapter (isolated, default) or
 * shared as a process-wide singleton across many stories (opt-in).
 *
 * It owns exactly one v86 emulator, one persistent serial pump, one byte-paced
 * writer, and the periodic tick/sync timers. The tmuxy-wasm core is swappable:
 * on `reset()` the engine restores the pinned snapshot and installs a FRESH core,
 * so a reused instance starts each story from an identical clean state (no bleed
 * of panes/windows/sessions/theme from the previous story).
 *
 * The current adapter wires its state/clipboard callbacks via `setSink()`; the
 * engine calls back into whichever sink is currently attached.
 */
import type { ServerState, StateUpdate, PaneContent } from '../types';

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';
const V86_WASM = '/v86/v86.wasm';
const STATE_URL = '/v86-img/tmux-state.bin';
const STATE_GZ_URL = '/v86-img/tmux-state.bin.gz';
const STATE_ZST_URL = '/v86-img/tmux-state.bin.zst';
const SEABIOS_URL = '/v86-img/seabios.bin';
const VGABIOS_URL = '/v86-img/vgabios.bin';
const BZIMAGE_URL = '/v86-img/buildroot-bzimage.bin';
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
// The snapshot has session `m` with tmux already running; attach a fresh control
// client each boot/reset (the snapshot predates any control-mode attach).
const ATTACH = '/tmp/tb/tmux -CC attach -t m\n';

// Guest bootstrap commands sent after every attach. Everything durable
// (script paths, command-aliases, config, PS1, symlinks) is BAKED into the
// snapshot by scripts/build-v86-snapshot.mjs — snapshot restores rewind the
// filesystem, so only per-attach setup belongs here: the same session-level
// settings the native monitor's enforce_settings() applies on connect
// (allow-passthrough gates image/hyperlink OSC forwarding; pane-border-status
// top is assumed by PaneLayout's geometry).
const GUEST_SETUP: string[] = [
  // GLOBAL (-g) so EVERY window — including tabs born later from
  // `new-window` → splitw+breakp — inherits it. Without -g it's a per-window
  // option that only lands on the window active at attach, leaving new tabs at
  // pane y=0 where PaneHeader steals the first content row. tmux 3.7a in the
  // guest has no issue with -g here (the 3.5a control-mode caveat that keeps the
  // native monitor per-session does not apply to this emulator).
  'set -g pane-border-status top',
  "set -g pane-border-format ' '",
  'set mouse on',
  'set focus-events on',
  'set allow-passthrough on',
  'set allow-rename on',
  'set set-titles on',
  'setw -g aggressive-resize off',
];

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  restore_state(state: ArrayBuffer): Promise<void>;
  destroy?: () => Promise<void>;
}
interface FeedOutput {
  updates: StateUpdate[];
  commands: string[];
  clipboard: [string, string][];
  /** (success, first output line) per %begin/%end/%error block, in order. */
  responses: [boolean, string][];
}
interface WasmCore {
  feed(text: string): FeedOutput;
  tick(): FeedOutput;
  snapshot(): ServerState;
  initial_sync(): string[];
  image_url(paneId: string, imageId: number): string | undefined;
  active_pane_id(): string | undefined;
  active_window_id(): string | undefined;
  parse_scrollback(text: string, width: number): PaneContent;
}
interface WasmModule {
  default(input?: string): Promise<unknown>;
  WasmTmux: new (session: string) => WasmCore;
}

/** Where the engine forwards reconstructed state + clipboard writes. */
export interface EngineSink {
  onState(state: ServerState): void;
  onClipboard(paneId: string, text: string): void;
  /** The control-mode stream ended (`%exit`) — the tmux server died or the
   *  client was detached. Non-recoverable for this attach. */
  onFatal(message: string): void;
}

const EMPTY_STATE: ServerState = {
  session_name: 'm',
  active_window_id: null,
  active_pane_id: null,
  panes: [],
  windows: [],
  total_width: 80,
  total_height: 24,
  status_line: '',
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  // Tracked-command correlation. Control mode replies strictly in send order,
  // but the core also sends its own commands (captures, list-panes), so we
  // don't count blocks — we tag each tracked command with a display-message
  // marker: when the marker's response appears, the following `remaining`
  // responses belong to the tracked command list.
  private trackSeq = 0;
  private trackers = new Map<
    string,
    {
      remaining: number;
      ok: boolean;
      message: string;
      resolve(r: { ok: boolean; message: string }): void;
    }
  >();
  private armedTracker: string | null = null;
  private attached = false;
  private lastState: ServerState = EMPTY_STATE;
  private readonly decoder = new TextDecoder();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;

  // Scrollback capture (client-side copy mode) — see captureScrollback().
  private captureSeq = 0;
  private captures = new Map<
    string,
    { lines: string[]; resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private activeCaptureId: string | null = null;
  private captureLineBuf = '';

  /** The sink for the CURRENTLY-attached adapter (null between stories). */
  private sink: EngineSink | null = null;

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

  getLastState(): ServerState {
    return this.lastState;
  }

  imageUrl(paneId: string, imageId: number): string | undefined {
    return this.core?.image_url(paneId, imageId);
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
    const id = String(++this.captureSeq);
    const startMark = `TMUXY_CAP_START_${id}`;
    const endMark = `TMUXY_CAP_END_${id}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.captures.delete(id)) {
          if (this.activeCaptureId === id) this.activeCaptureId = null;
          resolve('');
        }
      }, 15000);
      this.captures.set(id, { lines: [], resolve, timer });
      this.send(
        `display-message -p '${startMark}' ; ` +
          `capture-pane -t ${paneId} -p -e -S ${start} -E ${end} ; ` +
          `display-message -p '${endMark}'`,
      );
    });
  }

  /**
   * Scan a raw control-mode chunk for scrollback-capture markers and collect
   * the lines between them. Skips control-mode framing (`%begin`/`%end`/…) so
   * only real captured content is kept.
   */
  private scanCaptures(chunk: string): void {
    this.captureLineBuf += chunk;
    const parts = this.captureLineBuf.split('\n');
    // Keep the trailing partial line for the next chunk.
    this.captureLineBuf = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      const startIdx = line.indexOf('TMUXY_CAP_START_');
      if (startIdx !== -1) {
        this.activeCaptureId = line.slice(startIdx + 'TMUXY_CAP_START_'.length).trim();
        continue;
      }
      const endIdx = line.indexOf('TMUXY_CAP_END_');
      if (endIdx !== -1) {
        const id = line.slice(endIdx + 'TMUXY_CAP_END_'.length).trim();
        const cap = this.captures.get(id);
        if (cap) {
          clearTimeout(cap.timer);
          this.captures.delete(id);
          cap.resolve(cap.lines.join('\n'));
        }
        if (this.activeCaptureId === id) this.activeCaptureId = null;
        continue;
      }
      if (this.activeCaptureId !== null && !/^%(begin|end|error)\b/.test(line)) {
        this.captures.get(this.activeCaptureId)?.lines.push(line);
      }
    }
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
    const wasm = (await import(/* @vite-ignore */ WASM_JS)) as unknown as WasmModule;
    await wasm.default(WASM_BG);
    this.wasmModule = wasm;
    this.core = new wasm.WasmTmux('m');

    const { V86 } = (await import('v86')) as unknown as {
      V86: new (opts: Record<string, unknown>) => V86Emulator;
    };
    const emu: V86Emulator = new V86({
      wasm_path: V86_WASM,
      bios: { url: SEABIOS_URL },
      vga_bios: { url: VGABIOS_URL },
      bzimage: { url: BZIMAGE_URL },
      cmdline: CMDLINE,
      filesystem: {},
      memory_size: 64 * 1024 * 1024,
      vga_memory_size: 2 * 1024 * 1024,
      disable_keyboard: true,
      disable_mouse: true,
      // The snapshot dominates the payload: ship zstd (v86 decompresses .zst
      // initial_state natively, in-wasm). The reset path lazily fetches the
      // .gz variant instead (DecompressionStream has no zstd).
      initial_state: { url: STATE_ZST_URL },
      autostart: true,
    });
    this.emu = emu;

    // Serve inline terminal-image bytes from the CURRENT wasm store (no backend).
    (
      window as unknown as { __tmuxyImageSrc?: (p: string, i: number) => string | undefined }
    ).__tmuxyImageSrc = (paneId, imageId) => this.core?.image_url(paneId, imageId);
    // Test hook: lets stories assert bursts ride the delta wire path.
    (window as unknown as { __v86UpdateStats?: { full: number; delta: number } }).__v86UpdateStats =
      this.updateStats;

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
      if (chunk.includes('1337') || chunk.includes(']1337'))
        (window as unknown as { __osc?: string[] }).__osc?.push(chunk.slice(0, 400));
      if (this.captures.size > 0) this.scanCaptures(chunk);
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
    await this.start(initCommands, false);
  }

  /** Fetch the machine snapshot, preferring the gzip + local inflate (half
   *  the wire size); falls back to the raw file when the .gz or
   *  DecompressionStream is unavailable. Cached — reset() reuses the bytes. */
  private async fetchSnapshot(): Promise<ArrayBuffer> {
    if (this.snapshotBytes) return this.snapshotBytes;
    if (typeof DecompressionStream !== 'undefined') {
      const res = await fetch(STATE_GZ_URL);
      if (res.ok && res.body) {
        // If the server declared `Content-Encoding: gzip` the browser already
        // inflated the body — piping it through DecompressionStream again would
        // double-inflate and corrupt the snapshot. Only inflate ourselves when
        // the bytes are still compressed.
        const alreadyInflated = /gzip/i.test(res.headers.get('content-encoding') ?? '');
        const stream = alreadyInflated
          ? res.body
          : res.body.pipeThrough(new DecompressionStream('gzip'));
        const bytes = await new Response(stream).arrayBuffer();
        this.snapshotBytes = bytes;
        return bytes;
      }
    }
    const raw = await fetch(STATE_URL).then((r) => r.arrayBuffer());
    this.snapshotBytes = raw;
    return raw;
  }

  private async doReset(initCommands: string[]): Promise<void> {
    // Call doBoot directly (not boot) — we're already inside the lifecycle
    // queue, and re-enqueuing would deadlock behind ourselves.
    if (!this.emu || !this.wasmModule) return this.doBoot(initCommands);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.byteBuf = '';
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
    // The attach is RETRIED when no state arrives: the emulated UART can drop
    // bytes right after a snapshot restore, and a mangled attach line would
    // otherwise leave the story dead forever (an idle guest emits nothing, so
    // there is no later event to recover on). A retry's stray text lands either
    // on the shell prompt (errors harmlessly) or in control-mode stdin (an
    // unknown-command %error) — both tolerated by the parser.
    for (let attempt = 0; attempt < 3; attempt++) {
      const firstState = new Promise<void>((r) => (this.resolveFirstState = r));
      this.attached = true;
      this.send(ATTACH);
      await wait(warm ? 500 : 1000);
      this.send('refresh-client -C 80x24');
      // Bootstrap the guest so app-issued helper-script paths + command-aliases
      // resolve (see GUEST_SETUP).
      for (const cmd of GUEST_SETUP) this.send(cmd);
      // tmux doesn't replay list-panes/list-windows on attach; request them so
      // the active window/pane populate (drives active-pane style + cursor).
      for (const cmd of this.core.initial_sync()) this.send(cmd);
      await Promise.race([firstState, wait(attempt === 0 ? 8000 : 6000)]);
      if (this.lastState.panes.length > 0) break;
    }
    // Init commands only once, after the attach demonstrably works — a resend
    // would duplicate their effects (an extra split-window, say).
    for (const cmd of initCommands) this.send(cmd);
  }

  /** Re-request the full window/pane list (used after switch-session). */
  resync(): void {
    for (const cmd of this.core?.initial_sync() ?? []) this.send(cmd);
  }

  /** full/delta counts since boot — test hook + perf visibility. */
  readonly updateStats = { full: 0, delta: 0 };

  private emit(out: FeedOutput): void {
    if (!this.core || !this.emu) return;
    for (const [ok, firstLine] of out.responses ?? []) this.onResponse(ok, firstLine);
    for (const cmd of out.commands) this.send(cmd);
    for (const [paneId, text] of out.clipboard) this.sink?.onClipboard(paneId, text);
    if (out.updates.length === 0) return;
    // Count the core's wire-protocol emissions (full vs delta) — the protocol
    // itself is exercised and asserted (Throughput, DeltaProtocol stories) even
    // though the EMITTED state below comes from a per-batch snapshot.
    //
    // KNOWN LIMITATION (documented in the gap plan): chaining the updates via
    // handleStateUpdate is not usable as the emitted state yet — an update
    // computed earlier in a burst carries a pre-select-pane active id, and the
    // appMachine's optimistic-focus/layout-transition heuristics (tuned against
    // server-timed emissions) permanently pin the stale focus. The per-batch
    // snapshot is always internally consistent, which those heuristics assume.
    for (const update of out.updates) {
      this.updateStats[update.type === 'full' ? 'full' : 'delta'] += 1;
    }
    const state = this.core.snapshot();
    // serde-wasm-bindgen serializes Option::None as `undefined`; the wire
    // schema (and the strict get_initial_state decode) expects `null`.
    state.active_window_id ??= null;
    state.active_pane_id ??= null;
    this.lastState = state;
    this.sink?.onState(state);
    if (state.panes.length > 0 && this.resolveFirstState) {
      this.resolveFirstState();
      this.resolveFirstState = null;
    }
  }

  private onResponse(ok: boolean, firstLine: string): void {
    if (this.armedTracker) {
      const t = this.trackers.get(this.armedTracker);
      if (t) {
        if (!ok && t.ok) {
          t.ok = false;
          t.message = firstLine;
        }
        t.remaining -= 1;
        if (t.remaining <= 0) {
          this.trackers.delete(this.armedTracker);
          this.armedTracker = null;
          t.resolve({ ok: t.ok, message: t.message });
          return;
        }
      } else {
        this.armedTracker = null;
      }
      return;
    }
    const m = firstLine.match(/^TMUXY_RC_(\d+)$/);
    if (m && this.trackers.has(m[1])) this.armedTracker = m[1];
  }

  /**
   * Send a command (or ` ; `-separated command list) and resolve with its real
   * outcome — success, or the first %error line. A display-message marker is
   * prepended so the reply can be picked out of the FIFO regardless of what the
   * core sends in between. Falls back to success on timeout so a wedged guest
   * degrades to fire-and-forget rather than erroring spuriously.
   */
  sendTracked(cmd: string): Promise<{ ok: boolean; message: string }> {
    const id = String(++this.trackSeq);
    const remaining = cmd.split(' ; ').length;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.trackers.delete(id)) resolve({ ok: true, message: 'tracking timeout' });
      }, 15000);
      this.trackers.set(id, {
        remaining,
        ok: true,
        message: '',
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.send(`display-message -p 'TMUXY_RC_${id}' ; ${cmd}`);
    });
  }

  /** Queue a control-mode command; streamed to the guest byte-paced. */
  send(cmd: string): void {
    const text = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    // Enqueue as UTF-8: v86's serial0_send writes one byte per JS char
    // (charCode & 0xFF), so multibyte characters (CJK from IME composition,
    // emoji in pasted text) must be expanded to their UTF-8 bytes here — and
    // the FIFO pacing below must count BYTES, not UTF-16 units.
    const utf8 = new TextEncoder().encode(text);
    let bin = '';
    for (const b of utf8) bin += String.fromCharCode(b);
    this.byteBuf += bin;
    this.drainQueue();
  }

  // Stream pending bytes to the guest UART a small chunk at a time so its RX FIFO
  // never overruns (which would drop bytes mid-command). 8 bytes/4ms stays well
  // under a 16-byte 16550 FIFO while sending ~2KB/s — ample for control commands
  // and fast typing.
  private static readonly CHUNK_BYTES = 8;
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
