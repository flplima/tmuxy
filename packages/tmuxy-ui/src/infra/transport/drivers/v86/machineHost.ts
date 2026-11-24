/**
 * The machine's end of the worker (`machine.worker.ts`; the page's end and
 * the protocol are `machine.ts`): it owns the v86 emulator, the snapshot
 * bytes, the paced writes to the UART and the gathering of its output, and
 * answers the page's requests.
 */
import type { MachineEvent, MachineRequest, VgaScreen } from './machine';
import { PacedWriter, SerialCollector } from './serialLink';
import {
  createV86Emulator,
  fetchGuestSnapshot,
  restoreSnapshot,
  type V86Emulator,
} from './v86Guest';

/** How often a watched text console is read for changes: it is for a person
 *  looking at it, not for a test. */
export const SCREEN_POLL_MS = 100;

/** The worker's global scope, as far as the host uses it. */
export interface MachineScope {
  postMessage(event: MachineEvent, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<MachineRequest>) => void): void;
  addEventListener(
    type: 'unhandledrejection',
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

/** Where the emulator and its snapshot come from (fakes, under test). */
export interface MachineParts {
  createEmulator: typeof createV86Emulator;
  fetchSnapshot: typeof fetchGuestSnapshot;
}

const V86_PARTS: MachineParts = {
  createEmulator: createV86Emulator,
  fetchSnapshot: fetchGuestSnapshot,
};

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function serveMachine(scope: MachineScope, parts: MachineParts = V86_PARTS): void {
  const host = new MachineHost(scope, parts);
  scope.addEventListener('message', (event) => host.handle(event.data));
  // A rejection nothing handles (one inside v86's own loaders) never reaches
  // the page by itself, unlike an uncaught error: the page would wait on a
  // machine that is not coming.
  scope.addEventListener('unhandledrejection', (event) =>
    scope.postMessage({ type: 'fatal', message: reasonOf(event.reason) }),
  );
}

class MachineHost {
  private emu: V86Emulator | null = null;
  /** Each state by URL, fetched once and kept for every restore: their tens
   *  of megabytes stay here. */
  private readonly states = new Map<string, Promise<ArrayBuffer>>();
  private writer: PacedWriter | null = null;
  private readonly output: SerialCollector;
  private screenTimer: ReturnType<typeof setInterval> | null = null;
  private lastScreen = '';
  private cursor: VgaScreen['cursor'] = null;

  constructor(
    private readonly scope: MachineScope,
    private readonly parts: MachineParts,
  ) {
    this.output = new SerialCollector((bytes) =>
      scope.postMessage({ type: 'serial', bytes }, [bytes.buffer]),
    );
  }

  handle(request: MachineRequest): void {
    switch (request.type) {
      case 'boot':
        return this.answer(request.id, () => this.boot(request.url));
      case 'restore':
        return this.answer(request.id, () => this.restore(request.url));
      case 'write':
        return this.writer?.push(request.bytes);
      case 'watch-screen':
        return this.watchScreen(request.on);
    }
  }

  private answer(id: number, op: () => Promise<void>): void {
    Promise.resolve()
      .then(op)
      .then(
        () => this.scope.postMessage({ type: 'done', id, error: null }),
        (err: unknown) => this.scope.postMessage({ type: 'done', id, error: reasonOf(err) }),
      );
  }

  private machine(): V86Emulator {
    if (!this.emu) throw new Error('the guest machine is not booted');
    return this.emu;
  }

  private async boot(url: string): Promise<void> {
    // Asked for first, so the download overlaps the emulator's own start.
    const snapshot = this.state(url);
    const { emu, loaded } = await this.parts.createEmulator();
    this.emu = emu;
    emu.add_listener('serial0-output-byte', (byte) => this.output.push(byte));
    this.writer = new PacedWriter((bytes) => emu.serial0_send(bytes));
    await loaded;
    emu.screen_adapter.update_cursor = (row, col) => {
      this.cursor = { row, col };
    };
    await restoreSnapshot(emu, await snapshot);
    await emu.run();
  }

  /**
   * The rewind and the clearing of both directions happen in one task, with
   * no output in between: what the old machine printed is dropped, or was
   * posted before the answer, and what was queued for it is never sent.
   */
  private async restore(url: string): Promise<void> {
    const emu = this.machine();
    const snapshot = await this.state(url);
    this.writer?.clear();
    this.output.clear();
    await restoreSnapshot(emu, snapshot);
  }

  private state(url: string): Promise<ArrayBuffer> {
    let bytes = this.states.get(url);
    if (!bytes) {
      bytes = this.parts.fetchSnapshot(url);
      // A failed fetch fails the start that awaits it; it is not left unhandled.
      bytes.catch(() => {});
      this.states.set(url, bytes);
    }
    return bytes;
  }

  private watchScreen(on: boolean): void {
    if (this.screenTimer !== null) clearInterval(this.screenTimer);
    this.screenTimer = on ? setInterval(() => this.sendScreen(), SCREEN_POLL_MS) : null;
    this.lastScreen = '';
  }

  private sendScreen(): void {
    if (!this.emu) return;
    const screen: VgaScreen = {
      rows: this.emu.screen_adapter.get_text_screen(),
      cursor: this.cursor,
    };
    const seen = JSON.stringify(screen);
    if (seen === this.lastScreen) return;
    this.lastScreen = seen;
    this.scope.postMessage({ type: 'screen', screen });
  }
}
