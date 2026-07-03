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
import type { ServerState } from '../types';

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';
const V86_WASM = '/v86/v86.wasm';
const STATE_URL = '/v86-img/tmux-state.bin';
const SEABIOS_URL = '/v86-img/seabios.bin';
const VGABIOS_URL = '/v86-img/vgabios.bin';
const BZIMAGE_URL = '/v86-img/buildroot-bzimage.bin';
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
// The snapshot has session `m` with tmux already running; attach a fresh control
// client each boot/reset (the snapshot predates any control-mode attach).
const ATTACH = '/tmp/tb/tmux -CC attach -t m\n';

// Guest bootstrap, sent over control mode after every attach (cold boot AND
// snapshot reset — restore_state rewinds the whole machine, wiping prior setup).
// The app invokes helper scripts as `$HOME/.config/tmuxy/bin/tmuxy/<script>` and
// via `tmuxy-*` command-aliases (see .devcontainer/.tmuxy.defaults.conf); the
// pre-built snapshot ships the scripts at /tmp/tb/bin/tmuxy but defines neither
// the path nor the aliases, so pane-group close/nav/sidebar would silently no-op.
const GUEST_SETUP = [
  'run-shell "mkdir -p /root/.config/tmuxy/bin && ln -sfn /tmp/tb/bin/tmuxy /root/.config/tmuxy/bin/tmuxy"',
  // The baked snapshot predates the float-create ##{pane_id} escape fix: its
  // run-shell'd split-window -F '#{pane_id}' pre-expands to the ACTIVE pane and
  // the float then breaks the WRONG pane. Patch the guest copy in place. Hashes
  // are quadrupled so THIS run-shell's own expansion halves them (#### -> ##).
  `run-shell "sed -i 's|##{pane_id}|####{pane_id}|g' /tmp/tb/bin/tmuxy/float-create"`,
  `set -s command-alias[100] 'tmuxy-pane-group-add=run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-add #{pane_id} #{pane_width} #{pane_height}"'`,
  `set -s command-alias[101] 'tmuxy-pane-group-prev=run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-prev #{pane_id}"'`,
  `set -s command-alias[102] 'tmuxy-pane-group-next=run-shell "$HOME/.config/tmuxy/bin/tmuxy/pane-group-next #{pane_id}"'`,
  `set -s command-alias[110] 'tmuxy-nav-left=run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav left #{pane_id}"'`,
  `set -s command-alias[111] 'tmuxy-nav-right=run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav right #{pane_id}"'`,
  `set -s command-alias[112] 'tmuxy-nav-up=run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav up #{pane_id}"'`,
  `set -s command-alias[113] 'tmuxy-nav-down=run-shell "bash $HOME/.config/tmuxy/bin/tmuxy/nav down #{pane_id}"'`,
];

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  restore_state(state: ArrayBuffer): Promise<void>;
  destroy?: () => Promise<void>;
}
interface FeedOutput {
  updates: unknown[];
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
  private trackers = new Map<string, { remaining: number; ok: boolean; message: string; resolve(r: { ok: boolean; message: string }): void }>();
  private armedTracker: string | null = null;
  private attached = false;
  private lastState: ServerState = EMPTY_STATE;
  private readonly decoder = new TextDecoder();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private resolveFirstState: (() => void) | null = null;

  /** The sink for the CURRENTLY-attached adapter (null between stories). */
  private sink: EngineSink | null = null;

  isBooted(): boolean {
    return this.booted;
  }

  setSink(sink: EngineSink | null): void {
    this.sink = sink;
  }

  getLastState(): ServerState {
    return this.lastState;
  }

  imageUrl(paneId: string, imageId: number): string | undefined {
    return this.core?.image_url(paneId, imageId);
  }

  /** Cold boot: load wasm, create the emulator, register the persistent serial
   *  pump + timers, then attach + sync + run `initCommands`. Call once. */
  async boot(initCommands: string[]): Promise<void> {
    const wasm = (await import(/* @vite-ignore */ WASM_JS)) as unknown as WasmModule;
    await wasm.default(WASM_BG);
    this.wasmModule = wasm;
    this.core = new wasm.WasmTmux('m');

    const { V86 } = (await import('v86')) as unknown as {
      V86: new (opts: Record<string, unknown>) => V86Emulator;
    };
    this.emu = new V86({
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
      initial_state: { url: STATE_URL },
      autostart: true,
    });

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

  /** Reuse path: restore the pinned snapshot, install a fresh core, re-attach.
   *  Gives each story an identical clean starting state on a shared instance. */
  async reset(initCommands: string[]): Promise<void> {
    if (!this.emu || !this.wasmModule) return this.boot(initCommands);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.byteBuf = '';
    if (!this.snapshotBytes) {
      // Browser cache serves this from the initial_state load — no extra network.
      this.snapshotBytes = await fetch(STATE_URL).then((r) => r.arrayBuffer());
    }
    const bytes = this.snapshotBytes;
    // restore_state consumes the buffer; hand it a fresh copy each reset.
    if (bytes) await this.emu.restore_state(bytes.slice(0));
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
    const firstState = new Promise<void>((r) => (this.resolveFirstState = r));
    await wait(warm ? 400 : 1500);
    this.attached = true;
    this.send(ATTACH);
    await wait(warm ? 500 : 1000);
    this.send('refresh-client -C 80x24');
    // Bootstrap the guest so app-issued helper-script paths + command-aliases
    // resolve (see GUEST_SETUP).
    for (const cmd of GUEST_SETUP) this.send(cmd);
    // tmux doesn't replay list-panes/list-windows on attach; request them so the
    // active window/pane populate (drives active-pane style + cursor).
    for (const cmd of this.core.initial_sync()) this.send(cmd);
    for (const cmd of initCommands) this.send(cmd);
    await Promise.race([firstState, wait(8000)]);
  }

  /** Re-request the full window/pane list (used after switch-session). */
  resync(): void {
    for (const cmd of this.core?.initial_sync() ?? []) this.send(cmd);
  }

  private emit(out: FeedOutput): void {
    if (!this.core || !this.emu) return;
    for (const [ok, firstLine] of out.responses ?? []) this.onResponse(ok, firstLine);
    for (const cmd of out.commands) this.send(cmd);
    for (const [paneId, text] of out.clipboard) this.sink?.onClipboard(paneId, text);
    if (out.updates.length === 0) return;
    const state = this.core.snapshot();
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
    this.byteBuf += cmd.endsWith('\n') ? cmd : `${cmd}\n`;
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
