/**
 * The guest machine under CheerpX, Leaning Technologies' x86-to-WebAssembly
 * JIT: 32-bit Linux binaries run straight from an ext2 image the page streams
 * over HTTP, with no kernel to boot and no snapshot to download. The image is
 * built by scripts/build-cheerpx-image.mjs; packages/tmuxy-ui/cheerpx/README.md
 * has what CheerpX does differently and how the guest copes.
 *
 * The control-mode client runs on CheerpX's console: the page runs the
 * guest's `tmuxy-console` relay there, writes commands into it and reads the
 * stream back. CheerpX needs SharedArrayBuffer, so the page must be
 * cross-origin isolated (COOP + COEP); `cheerpxAvailable()` says whether it is.
 */
import {
  GUEST_DEFAULT_COLS,
  GUEST_DEFAULT_ROWS,
  GuestEngine,
  GUEST_FILES_DIR,
  type AttachTiming,
  type GuestFile,
} from '../guest/GuestEngine';

/** CheerpX's runtime, from Leaning Technologies' CDN (its license allows the
 *  CDN build for open-source use). */
const CX_URL = 'https://cxrtnc.leaningtech.com/1.4.0/cx.esm.js';
const IMAGE_URL = '/cheerpx-img/tmuxy.ext2';
/** Starts tmux if it is not running and attaches a control client to the console. */
const RELAY = '/usr/local/bin/tmuxy-console';
/** The IndexedDB overlay the guest's writes go to, one per page load. */
const OVERLAY_PREFIX = 'tmuxy-cheerpx-';
const GUEST_ENV = [
  'HOME=/root',
  'USER=root',
  'SHELL=/bin/bash',
  'TERM=xterm-256color',
  'LANG=C.UTF-8',
  'LC_ALL=C.UTF-8',
];
/** The relay attaches the control client itself, about a second after the
 *  page starts it when the image is cached; streaming the image from a slow
 *  network takes longer. */
const TIMING: AttachTiming = { settleMs: 500, attachMs: 0, attemptMs: 2000, deadlineMs: 60000 };

interface CheerpXDevice {
  readonly __device: unique symbol;
}
/** An in-memory folder the page writes into. */
interface CheerpXDataDevice extends CheerpXDevice {
  writeFile(path: string, data: Uint8Array): Promise<void>;
}
interface CheerpXLinux {
  setCustomConsole(
    write: (bytes: Uint8Array) => void,
    cols: number,
    rows: number,
  ): (byte: number) => void;
  run(
    path: string,
    args: string[],
    opts: { env: string[]; cwd: string; uid: number; gid: number },
  ): Promise<unknown>;
}
interface CheerpXModule {
  HttpBytesDevice: { create(url: string): Promise<CheerpXDevice> };
  IDBDevice: { create(name: string): Promise<CheerpXDevice> };
  DataDevice: { create(): Promise<CheerpXDataDevice> };
  OverlayDevice: { create(base: CheerpXDevice, overlay: CheerpXDevice): Promise<CheerpXDevice> };
  Linux: {
    create(opts: {
      mounts: { type: string; path: string; dev?: CheerpXDevice }[];
    }): Promise<CheerpXLinux>;
  };
}

/** Whether this page can run CheerpX: it needs SharedArrayBuffer, which only a
 *  cross-origin isolated page has. */
export function cheerpxAvailable(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

export class CheerpXEngine extends GuestEngine {
  private consoleSend: ((byte: number) => void) | null = null;
  /** Mounted at `GUEST_FILES_DIR`; it lives as long as the machine. */
  private files: CheerpXDataDevice | null = null;
  private readonly encoder = new TextEncoder();

  protected async doBoot(initCommands: string[], files: GuestFile[]): Promise<void> {
    if (!cheerpxAvailable()) {
      throw new Error('CheerpX needs a cross-origin isolated page (COOP and COEP headers)');
    }
    await this.freshCore();
    const CheerpX = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ CX_URL
    )) as CheerpXModule;
    const disk = await CheerpX.HttpBytesDevice.create(new URL(IMAGE_URL, location.href).href);
    // Each page load starts from the image as built: a new overlay, and the
    // ones earlier loads left are dropped (a database another tab still holds
    // open is deleted once that tab lets go).
    const databases = await indexedDB.databases();
    for (const { name } of databases) {
      if (name?.startsWith(OVERLAY_PREFIX)) indexedDB.deleteDatabase(name);
    }
    const writes = await CheerpX.IDBDevice.create(`${OVERLAY_PREFIX}${Date.now()}`);
    const root = await CheerpX.OverlayDevice.create(disk, writes);
    this.files = await CheerpX.DataDevice.create();
    const cx = await CheerpX.Linux.create({
      mounts: [
        { type: 'ext2', path: '/', dev: root },
        { type: 'devs', path: '/dev' },
        // Not in CheerpX's documentation, but what WebVM mounts: without it
        // openpty has no slave to open.
        { type: 'devpts', path: '/dev/pts' },
        { type: 'proc', path: '/proc' },
        { type: 'sys', path: '/sys' },
        { type: 'dir', path: GUEST_FILES_DIR, dev: this.files },
      ],
    });
    const decoder = new TextDecoder();
    this.consoleSend = cx.setCustomConsole(
      (bytes) => this.receive(decoder.decode(bytes, { stream: true })),
      GUEST_DEFAULT_COLS,
      GUEST_DEFAULT_ROWS,
    );
    this.booted = true;
    void cx.run(RELAY, [], { env: GUEST_ENV, cwd: '/root', uid: 0, gid: 0 }).then(() => {
      if (this.booted) this.sink?.onFatal('the guest console exited');
    });
    await this.putFiles(files);
    await this.start(initCommands, null, TIMING);
  }

  private async putFiles(files: GuestFile[]): Promise<void> {
    for (const { name, bytes } of files) await this.files?.writeFile(`/${name}`, bytes);
  }

  /** CheerpX has no snapshot to rewind to: a reset re-syncs a fresh core
   *  against the running guest, whose tmux keeps what the last adapter left. */
  protected async doReset(initCommands: string[], files: GuestFile[]): Promise<void> {
    if (!this.booted) return this.doBoot(initCommands, files);
    this.attached = false;
    this.failInFlight('engine reset');
    await this.freshCore();
    await this.putFiles(files);
    await this.start(initCommands, null, TIMING);
  }

  /** Write a control-mode command into the console, as UTF-8. */
  send(cmd: string): void {
    const send = this.consoleSend;
    if (!send) return;
    for (const byte of this.encoder.encode(cmd.endsWith('\n') ? cmd : `${cmd}\n`)) send(byte);
  }

  protected teardown(): void {
    this.consoleSend = null;
    this.files = null;
  }
}
