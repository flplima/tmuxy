/**
 * The guest machine as a v86 x86 emulator, restored from a pre-booted state
 * snapshot, its control-mode client on the emulated UART. Either owned by a
 * single adapter (isolated, default) or shared as a process-wide singleton
 * across many stories (opt-in): on `reset()` it restores the pinned snapshot
 * and installs a FRESH core, so a reused instance starts each story from an
 * identical clean state.
 *
 * It owns exactly one v86 emulator, one persistent serial pump and one paced
 * writer; the control-mode side is `GuestEngine`'s.
 */
import { GuestEngine, type AttachTiming, type GuestFile } from '../guest/GuestEngine';
import {
  ATTACH,
  createDetachedScreen,
  createV86Emulator,
  encodeUtf8SerialBytes,
  fetchGuestSnapshot,
  type V86Emulator,
} from './v86Guest';

/** A cold boot finishes bringing tmux up after the restore; a reset rewinds a
 *  running machine, which accepts the attach much sooner. */
const COLD: AttachTiming = { settleMs: 1500, attachMs: 1000, attemptMs: 4000, deadlineMs: 75000 };
const WARM: AttachTiming = { settleMs: 400, attachMs: 500, attemptMs: 2000, deadlineMs: 20000 };

export class V86Engine extends GuestEngine {
  private emu: V86Emulator | null = null;
  private snapshotBytes: ArrayBuffer | null = null;
  private byteBuf = '';
  private writing = false;
  private readonly decoder = new TextDecoder();

  /**
   * The guest's VGA text console, rendered by v86's own ScreenAdapter: a
   * detached element the emulator paints into (DOM rows of coloured spans in
   * text mode). Nothing in the app uses it — it exists so story tooling can
   * show the RAW tmux TUI (a second, read-only tmux client on /dev/tty1) next
   * to the tmuxy rendering. See stories/vgaMirror.ts. Painting is paused until
   * a viewer asks for it, so an unused screen costs nothing per frame.
   */
  private readonly screen: HTMLElement = createDetachedScreen();

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

  /** Cold boot: create the emulator, register the persistent serial pump,
   *  restore the snapshot, then attach + sync + run `initCommands`. */
  protected async doBoot(initCommands: string[], files: GuestFile[]): Promise<void> {
    await this.freshCore();

    // Start the snapshot fetch now so it overlaps machine init.
    const snapshotBytes = this.fetchSnapshot();
    const { emu, loaded } = await createV86Emulator(this.screen);
    this.emu = emu;

    // Throughput: v86 emits serial one byte at a time. Coalesce a burst into a
    // single feed() on a short timer instead of one wasm call per byte.
    let serialBuf = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      const chunk = serialBuf;
      serialBuf = '';
      this.receive(chunk);
    };
    this.emu.add_listener('serial0-output-byte', (byte: number) => {
      serialBuf += this.decoder.decode(new Uint8Array([byte]), { stream: true });
      if (flushTimer === null) flushTimer = setTimeout(flush, 8);
    });

    this.booted = true;

    // Wait for the machine to finish initializing, then restore the snapshot and
    // start the CPU from it (restore_state consumes the buffer, so hand it a
    // fresh copy and keep the cache for reset()). The restore itself is quick
    // (~2s), but the guest resumes a few seconds shy of ready — the snapshot is
    // captured mid-init, so on resume it finishes bringing tmux up — so this
    // still uses the patient (cold) budget, not the warm one.
    await loaded;
    await emu.restore_state((await snapshotBytes).slice(0));
    await emu.run();
    await this.putFiles(files);
    await this.start(initCommands, ATTACH, COLD);
  }

  /** Into the 9p share, which the restored guest has mounted at
   *  `GUEST_FILES_DIR`. A restore rewinds the share too, so each start writes
   *  them again. */
  private async putFiles(files: GuestFile[]): Promise<void> {
    for (const { name, bytes } of files) await this.emu?.create_file(name, bytes);
  }

  /** Fetch the machine snapshot (cached — reset() reuses the bytes). */
  private async fetchSnapshot(): Promise<ArrayBuffer> {
    if (this.snapshotBytes) return this.snapshotBytes;
    const bytes = await fetchGuestSnapshot();
    this.snapshotBytes = bytes;
    return bytes;
  }

  /** Reuse path: restore the pinned snapshot, install a fresh core, re-attach. */
  protected async doReset(initCommands: string[], files: GuestFile[]): Promise<void> {
    // Call doBoot directly (not boot) — we're already inside the lifecycle
    // queue, and re-enqueuing would deadlock behind ourselves.
    if (!this.emu) return this.doBoot(initCommands, files);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.byteBuf = '';
    this.failInFlight('engine reset');
    const bytes = await this.fetchSnapshot();
    // restore_state consumes the buffer; hand it a fresh copy each reset.
    await this.emu.restore_state(bytes.slice(0));
    await this.freshCore();
    await this.putFiles(files);
    await this.start(initCommands, ATTACH, WARM);
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

  protected teardown(): void {
    this.emu?.destroy?.().catch(() => {});
    this.emu = null;
  }
}

/** Process-wide singleton for opt-in sharing across stories. */
let sharedEngine: V86Engine | null = null;
export function getSharedEngine(): V86Engine {
  if (!sharedEngine) sharedEngine = new V86Engine();
  return sharedEngine;
}
