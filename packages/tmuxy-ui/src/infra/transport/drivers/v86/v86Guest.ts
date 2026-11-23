// The v86 machine: its emulator, BIOS, kernel and pre-booted snapshot.
import type { GuestSnapshot } from '../guest/GuestEngine';
import SNAPSHOTS from './snapshots.json';

const V86_JS = '/v86/libv86.mjs';
const V86_WASM = '/v86/v86.wasm';
/**
 * The machine states the guest restores, built by
 * `scripts/build-v86-snapshot.mjs` into `v86-assets` (served at /v86-img):
 * `generic`, which the stories start from (session `m`, one window of two
 * panes), and `demo`, the same machine with the demo site's showcase built
 * in it (session `tmuxy`, two tabs, a pane group, a preview and a picture).
 */
export type GuestSnapshotName = keyof typeof SNAPSHOTS;

export function guestSnapshot(name: GuestSnapshotName): GuestSnapshot {
  const { state, session } = SNAPSHOTS[name];
  return { url: `/v86-img/${state}`, session };
}

/** tmux is already running in a snapshot, which predates any control-mode
 *  attach: each boot/reset attaches a fresh control client to its session. */
export function attachLine(session: string): string {
  return `/tmp/tb/tmux -CC attach -t ${session}\n`;
}

export interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  restore_state(state: ArrayBuffer): Promise<void>;
  /** Start the CPU. Used to boot from an explicitly-restored snapshot (the
   *  constructor runs with `autostart: false`; see doBoot). */
  run(): Promise<void>;
  destroy?: () => Promise<void>;
  /** v86's ScreenAdapter — present once a `screen_container` was supplied. */
  screen_adapter?: { pause(): void; continue(): void };
  /** The emulator's internals; `restoreSnapshot` sets the guest's TSC through them. */
  v86: { cpu: V86Cpu };
}

interface V86Cpu {
  /** The guest's TSC, as [low, high] words, once `store_current_tsc` wrote it. */
  current_tsc: Uint32Array;
  store_current_tsc(): void;
  set_tsc(low: number, high: number): void;
}

/**
 * Rewind the machine to `snapshot`, its clock included. v86's `set_tsc` takes
 * the new offset from a TSC reading the old offset is already subtracted
 * from, so only a machine whose offset is zero lands on the TSC it is given:
 * a second restore on one emulator put the guest's TSC 99s behind the time
 * its restored kernel had read last, and the guest's clock stood still until
 * it caught up (a `sleep 1` slept for a minute and a half). Setting the TSC
 * to its own current value first brings the offset back to zero. Still the
 * case in v86 0.5.476, whose `set_tsc` computes `read_tsc() - new_value`.
 */
export async function restoreSnapshot(emu: V86Emulator, snapshot: ArrayBuffer): Promise<void> {
  const { cpu } = emu.v86;
  cpu.store_current_tsc();
  cpu.set_tsc(cpu.current_tsc[0], cpu.current_tsc[1]);
  // restore_state consumes the buffer; hand it a copy.
  await emu.restore_state(snapshot.slice(0));
}

export function createDetachedScreen(): HTMLElement {
  const el = document.createElement('div');
  el.appendChild(document.createElement('div'));
  el.appendChild(document.createElement('canvas'));
  return el;
}

/**
 * Constructed without `initial_state` and without autostart: v86 does not
 * decompress an `initial_state` URL (build/libv86: `f.url.endsWith(".zst") &&
 * "initial_state" !== f.name`), but its `restore_state` does inflate zstd
 * itself. The caller replays v86's own sequence — init → restore_state → run
 * — with the snapshot bytes as `fetchGuestSnapshot` got them. No kernel,
 * BIOS or command line is given: the machine never boots, it resumes.
 */
export async function createV86Emulator(
  screen: HTMLElement,
): Promise<{ emu: V86Emulator; loaded: Promise<void> }> {
  // Served, like the engine's glue, rather than bundled: v86 takes its Node
  // branches wherever `process` exists, and a bundler's `process` shim is
  // enough to send it there.
  const { V86 } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ V86_JS)) as {
    V86: new (opts: Record<string, unknown>) => V86Emulator;
  };
  const emu: V86Emulator = new V86({
    wasm_path: V86_WASM,
    filesystem: {},
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    disable_keyboard: true,
    disable_mouse: true,
    screen_container: screen,
    autostart: false,
  });
  // Machine-initialized signal (fired after v86's own init, before any run):
  // register before any await so a fast init can't beat us to it.
  const loaded = new Promise<void>((resolve) =>
    emu.add_listener('emulator-loaded', () => resolve()),
  );
  // Nobody is looking at the VGA console yet — see `screen`.
  emu.screen_adapter?.pause();
  return { emu, loaded };
}

/** Fetch the machine state at `url`, zstd-compressed; `restore_state` inflates it. */
export async function fetchGuestSnapshot(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`guest snapshot ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Enqueue as UTF-8: v86's serial0_send writes one byte per JS char
 * (charCode & 0xFF), so multibyte characters (CJK from IME composition,
 * emoji in pasted text) must be expanded to their UTF-8 bytes here — and
 * the pacing must count bytes, not UTF-16 units.
 */
export function encodeUtf8SerialBytes(cmd: string): string {
  const text = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
  const utf8 = new TextEncoder().encode(text);
  let bin = '';
  for (const b of utf8) bin += String.fromCharCode(b);
  return bin;
}

/**
 * Collects the guest's serial output, which v86 emits one byte per event, and
 * hands each burst to `receive` as one string decoded in a single call. The
 * decoder streams, so a multibyte character split across two bursts survives;
 * `reset` drops the bytes and any half character of the machine it replaces.
 */
export function createSerialPump(receive: (text: string) => void, delayMs = 8) {
  let bytes = new Uint8Array(4096);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let decoder = new TextDecoder();

  const flush = () => {
    timer = null;
    const text = decoder.decode(bytes.subarray(0, length), { stream: true });
    length = 0;
    receive(text);
  };

  return {
    push(byte: number): void {
      if (length === bytes.length) {
        const grown = new Uint8Array(length * 2);
        grown.set(bytes);
        bytes = grown;
      }
      bytes[length++] = byte;
      if (timer === null) timer = setTimeout(flush, delayMs);
    },
    reset(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      length = 0;
      decoder = new TextDecoder();
    },
  };
}
