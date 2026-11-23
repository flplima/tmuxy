/**
 * The guest machine as a v86 x86 emulator, restored from a pre-booted state
 * snapshot, its control-mode client on the emulated UART. Either owned by a
 * single adapter (isolated, default) or shared as a process-wide singleton
 * across many stories (opt-in): on `reset()` it restores the snapshot the
 * story names and installs a FRESH core, so a reused instance starts each
 * story from an identical clean state.
 *
 * It owns exactly one v86 emulator, one persistent serial pump and one paced
 * writer; the control-mode side is `GuestEngine`'s.
 */
import { GuestEngine, type AttachTiming, type GuestSnapshot } from '../guest/GuestEngine';
import {
  attachLine,
  createDetachedScreen,
  createSerialPump,
  createV86Emulator,
  encodeUtf8SerialBytes,
  fetchGuestSnapshot,
  restoreSnapshot,
  type V86Emulator,
} from './v86Guest';

/** A cold boot's machine has just loaded and may be slow to answer on a
 *  loaded runner; a reset rewinds one already running. Neither delays an
 *  answer that comes sooner. */
const COLD: AttachTiming = { attemptMs: 4000, deadlineMs: 75000 };
const WARM: AttachTiming = { attemptMs: 2000, deadlineMs: 20000 };

export class V86Engine extends GuestEngine {
  private emu: V86Emulator | null = null;
  /** Each state's bytes by URL, once fetched: a shared engine restores
   *  whichever one the next story names. */
  private readonly snapshots = new Map<string, ArrayBuffer>();
  private byteBuf = '';
  private writing = false;
  private readonly serial = createSerialPump((text) => this.receive(text));

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

  setScreenPainting(on: boolean): void {
    const adapter = this.emu?.screen_adapter;
    if (!adapter) return;
    if (on) adapter.continue();
    else adapter.pause();
  }

  protected async doBoot(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    await this.freshCore(snapshot.session);

    // Start the snapshot fetch now so it overlaps machine init.
    const snapshotBytes = this.fetchSnapshot(snapshot.url);
    const { emu, loaded } = await createV86Emulator(this.screen);
    this.emu = emu;

    // Throughput: v86 emits serial one byte at a time. The pump coalesces a
    // burst into a single decode and receive() on a short timer.
    this.emu.add_listener('serial0-output-byte', this.serial.push);

    this.booted = true;

    // Wait for the machine to finish initializing, then restore the snapshot and
    // start the CPU from it (the bytes stay cached for reset()); the attach line
    // goes in as soon as it runs.
    await loaded;
    await restoreSnapshot(emu, await snapshotBytes);
    await emu.run();
    await this.start(initCommands, attachLine(snapshot.session), COLD);
  }

  private async fetchSnapshot(url: string): Promise<ArrayBuffer> {
    const cached = this.snapshots.get(url);
    if (cached) return cached;
    const bytes = await fetchGuestSnapshot(url);
    this.snapshots.set(url, bytes);
    return bytes;
  }

  protected async doReset(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    // Call doBoot directly (not boot) — we're already inside the lifecycle
    // queue, and re-enqueuing would deadlock behind ourselves.
    if (!this.emu) return this.doBoot(snapshot, initCommands);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.byteBuf = '';
    this.serial.reset();
    this.failInFlight('engine reset');
    await restoreSnapshot(this.emu, await this.fetchSnapshot(snapshot.url));
    await this.freshCore(snapshot.session);
    await this.start(initCommands, attachLine(snapshot.session), WARM);
  }

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
  // buffer from filling behind a burst; a pace far below it (2 KB/s) queued
  // seconds of backlog behind a burst of splits and timed tracked commands out.
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
