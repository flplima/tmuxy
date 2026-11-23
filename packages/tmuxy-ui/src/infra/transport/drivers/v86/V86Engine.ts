/**
 * The guest machine as a v86 x86 emulator, restored from a pre-booted state
 * snapshot, its control-mode client on the emulated UART. Either owned by a
 * single adapter (isolated, default) or shared as a process-wide singleton
 * across many stories (opt-in): on `reset()` it restores the snapshot the
 * story names and installs a FRESH core, so a reused instance starts each
 * story from an identical clean state.
 *
 * The emulator itself runs in a worker of its own (`machine.ts`), which owns
 * the states' bytes, paces the writes to the UART and gathers its output;
 * this side decodes that output for the control-mode core, which is
 * `GuestEngine`'s.
 */
import { GuestEngine, type AttachTiming, type GuestSnapshot } from '../guest/GuestEngine';
import { spawnV86Machine, type MachineHandlers, type V86Machine, type VgaScreen } from './machine';
import { attachLine, serialLine } from './v86Guest';

/** A cold boot's machine has just loaded and may be slow to answer on a
 *  loaded runner; a reset rewinds one already running. Neither delays an
 *  answer that comes sooner. */
const COLD: AttachTiming = { attemptMs: 4000, deadlineMs: 75000 };
const WARM: AttachTiming = { attemptMs: 2000, deadlineMs: 20000 };

export class V86Engine extends GuestEngine {
  private machine: V86Machine | null = null;
  /** Streaming, so a character split across two chunks survives; a new one
   *  per machine, so half of one never carries into the next. */
  private decoder = new TextDecoder();

  /**
   * Who watches the guest's VGA text console. Nothing in the app does — it
   * exists so story tooling can show the RAW tmux TUI (a second, read-only
   * tmux client on /dev/tty1) next to the tmuxy rendering. See
   * stories/vgaMirror.ts. The machine reads the console only while someone
   * watches.
   */
  private readonly screenWatchers = new Set<(screen: VgaScreen) => void>();

  constructor(private readonly spawn: (handlers: MachineHandlers) => V86Machine = spawnV86Machine) {
    super();
  }

  /** Call `onScreen` with the VGA console (see `screenWatchers`) as it changes. */
  watchScreen(onScreen: (screen: VgaScreen) => void): () => void {
    this.screenWatchers.add(onScreen);
    if (this.screenWatchers.size === 1) this.machine?.watchScreen(true);
    return () => {
      if (this.screenWatchers.delete(onScreen) && this.screenWatchers.size === 0) {
        this.machine?.watchScreen(false);
      }
    };
  }

  protected async doBoot(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    await this.freshCore(snapshot.session);
    const machine: V86Machine = this.spawn({
      serial: (bytes) => {
        if (this.machine === machine) {
          this.receive(this.decoder.decode(bytes, { stream: true }));
        }
      },
      screen: (screen) => {
        if (this.machine === machine) for (const watch of this.screenWatchers) watch(screen);
      },
      fatal: (message) => {
        if (this.machine !== machine) return;
        this.dropMachine();
        this.sink?.onFatal(`the guest machine stopped: ${message}`);
      },
    });
    this.machine = machine;
    this.decoder = new TextDecoder();
    if (this.screenWatchers.size > 0) machine.watchScreen(true);
    this.booted = true;

    // The worker restores the state and starts the CPU from it (the bytes
    // stay there for reset()); the attach line goes in as soon as it runs.
    await this.onMachine(() => machine.boot(snapshot.url));
    await this.start(initCommands, attachLine(snapshot.session), COLD);
  }

  /** A machine that failed a step is gone: the next start boots a new one. */
  private async onMachine(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      this.dropMachine();
      throw err;
    }
  }

  protected async doReset(snapshot: GuestSnapshot, initCommands: string[]): Promise<void> {
    // Call doBoot directly (not boot) — we're already inside the lifecycle
    // queue, and re-enqueuing would deadlock behind ourselves.
    const machine = this.machine;
    if (!machine) return this.doBoot(snapshot, initCommands);
    // Stop feeding the (old) core while the machine rewinds.
    this.attached = false;
    this.failInFlight('engine reset');
    await this.onMachine(() => machine.restore(snapshot.url));
    this.decoder = new TextDecoder();
    await this.freshCore(snapshot.session);
    await this.start(initCommands, attachLine(snapshot.session), WARM);
  }

  send(cmd: string): void {
    this.machine?.write(serialLine(cmd));
  }

  private dropMachine(): void {
    this.machine?.destroy();
    this.machine = null;
    this.booted = false;
    this.attached = false;
  }

  protected teardown(): void {
    this.dropMachine();
  }
}

/** Process-wide singleton for opt-in sharing across stories. */
let sharedEngine: V86Engine | null = null;
export function getSharedEngine(): V86Engine {
  if (!sharedEngine) sharedEngine = new V86Engine();
  return sharedEngine;
}
