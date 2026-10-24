// The v86 machine: its emulator, BIOS, kernel and pre-booted snapshot.

const V86_JS = '/v86/libv86.mjs';
const V86_WASM = '/v86/v86.wasm';
const STATE_URL = '/v86-img/tmux-state.bin';
const STATE_GZ_URL = '/v86-img/tmux-state.bin.gz';
const SEABIOS_URL = '/v86-img/seabios.bin';
const VGABIOS_URL = '/v86-img/vgabios.bin';
const BZIMAGE_URL = '/v86-img/buildroot-bzimage.bin';
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
// The snapshot has session `m` with tmux already running; attach a fresh control
// client each boot/reset (the snapshot predates any control-mode attach).
export const ATTACH = '/tmp/tb/tmux -CC attach -t m\n';

export interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  restore_state(state: ArrayBuffer): Promise<void>;
  /** Write a file into the 9p share, by its path from the share's root. */
  create_file(file: string, data: Uint8Array): Promise<void>;
  /** Start the CPU. Used to boot from an explicitly-restored snapshot (the
   *  constructor runs with `autostart: false`; see doBoot). */
  run(): Promise<void>;
  destroy?: () => Promise<void>;
  /** v86's ScreenAdapter — present once a `screen_container` was supplied. */
  screen_adapter?: { pause(): void; continue(): void };
}

export function createDetachedScreen(): HTMLElement {
  const el = document.createElement('div');
  el.appendChild(document.createElement('div'));
  el.appendChild(document.createElement('canvas'));
  return el;
}

/**
 * Construct WITHOUT `initial_state` and WITHOUT autostart: v86 does NOT
 * zstd-decompress an `initial_state` URL (it skips decompression for that
 * resource specifically — build/libv86 `f.url.endsWith(".zst") && "initial_state"
 * !== f.name`), so handing it the .zst fed raw compressed bytes to
 * restore_state, which failed and silently fell back to a full kernel cold
 * boot (~30s, and flaky). Instead we replicate v86's own initial_state
 * sequence — init → restore_state → run — but restore the snapshot OURSELVES
 * from correctly-inflated bytes (fetchGuestSnapshot: .gz via DecompressionStream,
 * or the raw .bin), the same path the warm reset() already uses.
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
    bios: { url: SEABIOS_URL },
    vga_bios: { url: VGABIOS_URL },
    bzimage: { url: BZIMAGE_URL },
    cmdline: CMDLINE,
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

/**
 * Fetch the machine snapshot, preferring the gzip + local inflate (half
 * the wire size); falls back to the raw file when the .gz or
 * DecompressionStream is unavailable.
 */
export async function fetchGuestSnapshot(): Promise<ArrayBuffer> {
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
      return new Response(stream).arrayBuffer();
    }
  }
  return fetch(STATE_URL).then((r) => r.arrayBuffer());
}

/**
 * Enqueue as UTF-8: v86's serial0_send writes one byte per JS char
 * (charCode & 0xFF), so multibyte characters (CJK from IME composition,
 * emoji in pasted text) must be expanded to their UTF-8 bytes here — and
 * the FIFO pacing must count BYTES, not UTF-16 units.
 */
export function encodeUtf8SerialBytes(cmd: string): string {
  const text = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
  const utf8 = new TextEncoder().encode(text);
  let bin = '';
  for (const b of utf8) bin += String.fromCharCode(b);
  return bin;
}
