// The v86 machine: its emulator and pre-booted states. Built and driven
// inside the machine's worker (machineHost.ts); the page names the state and
// spells the lines it sends.
import type { GuestSnapshot } from '../guest/GuestEngine';
import type { YieldingMachine } from './haltedWait';
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
  /** Bytes as a string of one char per byte (`byteString`). */
  serial0_send(data: string): void;
  restore_state(state: ArrayBuffer): Promise<void>;
  /** Start the CPU. Used to boot from an explicitly-restored snapshot (the
   *  constructor runs with `autostart: false`; see `boot` in machineHost.ts). */
  run(): Promise<void>;
  /** Halt the CPU after its current slice; `run()` continues it. */
  stop(): Promise<void>;
  /** With no `screen_container` (a worker has no DOM), v86's text-only
   *  screen: it keeps the console's characters, and is told where the cursor
   *  moves without keeping it. Made in v86's own init: there once `loaded`. */
  screen_adapter: {
    get_text_screen(): string[];
    update_cursor(row: number, col: number): void;
  };
  /** The emulator's internals: `restoreSnapshot` sets the guest's TSC through
   *  them, and `waitWhileHalted` changes how the machine yields. */
  v86: { cpu: V86Cpu } & Partial<YieldingMachine>;
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

/**
 * Constructed without `initial_state` and without autostart: v86 does not
 * decompress an `initial_state` URL (build/libv86: `f.url.endsWith(".zst") &&
 * "initial_state" !== f.name`), but its `restore_state` does inflate zstd
 * itself. The caller replays v86's own sequence — init → restore_state → run
 * — with the snapshot bytes as `fetchGuestSnapshot` got them. No kernel,
 * BIOS or command line is given: the machine never boots, it resumes.
 */
export async function createV86Emulator(): Promise<{ emu: V86Emulator; loaded: Promise<void> }> {
  // Served, like the engine's glue, rather than bundled: v86 takes its Node
  // branches wherever `process` exists, and a bundler's `process` shim is
  // enough to send it there.
  const [{ V86 }, wasm] = await Promise.all([
    import(/* @vite-ignore */ /* webpackIgnore: true */ V86_JS) as Promise<{
      V86: new (opts: Record<string, unknown>) => V86Emulator;
    }>,
    compileV86Wasm(),
  ]);
  const emu: V86Emulator = new V86({
    wasm_fn: async (imports: WebAssembly.Imports) =>
      (await WebAssembly.instantiate(wasm, imports)).exports,
    filesystem: {},
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    disable_keyboard: true,
    disable_mouse: true,
    autostart: false,
  });
  // Machine-initialized signal (fired after v86's own init, before any run):
  // register before any await so a fast init can't beat us to it.
  const loaded = new Promise<void>((resolve) =>
    emu.add_listener('emulator-loaded', () => resolve()),
  );
  return { emu, loaded };
}

/**
 * Compiled here rather than by v86 (`wasm_fn` above): v86's own loader logs a
 * failed download and never finishes, which a page waiting on the machine
 * could only see as a hang. A download or compile that fails here fails the
 * boot with its reason.
 */
async function compileV86Wasm(): Promise<WebAssembly.Module> {
  const res = await fetch(V86_WASM);
  if (!res.ok) throw new Error(`${V86_WASM}: HTTP ${res.status}`);
  return WebAssembly.compile(await res.arrayBuffer());
}

/** Fetch the machine state at `url`, zstd-compressed; `restore_state` inflates it. */
export async function fetchGuestSnapshot(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`guest snapshot ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * A control-mode line as the bytes the UART carries: UTF-8, so multibyte
 * characters (CJK from IME composition, emoji in pasted text) reach the guest
 * whole, and the pacing counts bytes, not UTF-16 units.
 */
export function serialLine(cmd: string): Uint8Array {
  return new TextEncoder().encode(cmd.endsWith('\n') ? cmd : `${cmd}\n`);
}
