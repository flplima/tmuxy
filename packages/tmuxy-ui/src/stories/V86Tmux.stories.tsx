import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { useEffect, useRef, useState } from 'react';

/**
 * SPIKE — REAL tmux control mode, parsed by the REAL tmuxy Rust core, fully
 * client-side (Phases 0b + 1 + 2 + the WASM extraction).
 *
 * Pipeline, all in the browser:
 *   v86 (x86 Linux + real tmux 3.4) --serial--> tmux -CC control-mode stream
 *     --> tmuxy-wasm (tmuxy-core's parser + StateAggregator compiled to WASM)
 *     --> ServerState (panes/geometry/content) --> render.
 *
 * The WASM module is the SAME Rust code the native server runs — no TypeScript
 * reimplementation, no client-side VT emulator. The core also reports the tmux
 * commands to send back (capture-pane, list-panes) which we forward over the
 * serial link, closing the interactive loop.
 *
 * Assets (gitignored, served via .storybook staticDirs): v86 kernel/BIOS,
 * tmux-bundle.tar, tmux-state.bin snapshot, and /wasm (build: `npm run build:wasm`).
 * Tagged `spike`: excluded from the CI story probe.
 */

const WASM_PATH = '/v86/v86.wasm';
const STATE_URL = '/v86-img/tmux-state.bin';
const SEABIOS_URL = '/v86-img/seabios.bin';
const VGABIOS_URL = '/v86-img/vgabios.bin';
const BZIMAGE_URL = '/v86-img/buildroot-bzimage.bin';
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const ATTACH = '/tmp/tb/tmux -CC attach -t m\n';

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  destroy?: () => Promise<void>;
  stop?: () => Promise<void>;
}

interface WasmPane {
  tmux_id: string;
  width: number;
  height: number;
  x: number;
  y: number;
}
interface WasmCore {
  feed(text: string): { updates: unknown[]; commands: string[] };
  snapshot(): { panes: WasmPane[]; session_name: string };
}
interface WasmModule {
  default(input?: string): Promise<unknown>;
  WasmTmux: new (session: string) => WasmCore;
}

function V86TmuxWasmConsole() {
  const [status, setStatus] = useState('loading rust wasm core…');
  const [panes, setPanes] = useState<WasmPane[]>([]);
  const [feeds, setFeeds] = useState(0);
  const [raw, setRaw] = useState('');
  const rawRef = useRef('');
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let disposed = false;
    let emu: V86Emulator | null = null;
    const decoder = new TextDecoder();
    let core: WasmCore | null = null;
    let attached = false;
    let feedCount = 0;

    (async () => {
      // 1. Load the tmuxy Rust core (WASM) served at /wasm.
      const wasm = (await import(/* @vite-ignore */ WASM_JS)) as unknown as WasmModule;
      await wasm.default(WASM_BG);
      if (disposed) return;
      core = new wasm.WasmTmux('m');
      setStatus('restoring v86 snapshot…');

      // 2. Restore the pre-booted snapshot (real tmux already running).
      const { V86 } = (await import('v86')) as unknown as {
        V86: new (opts: Record<string, unknown>) => V86Emulator;
      };
      if (disposed) return;
      emu = new V86({
        wasm_path: WASM_PATH,
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

      emu.add_listener('serial0-output-byte', (byte: number) => {
        const chunk = decoder.decode(new Uint8Array([byte]), { stream: true });
        if (!chunk) return;
        rawRef.current = (rawRef.current + chunk).slice(-4000);
        setRaw(rawRef.current);
        if (!attached || !core) return;
        // 3. Feed real control-mode bytes to the Rust core. It returns the tmux
        //    commands to run (capture-pane/list-panes); forward them over serial.
        const out = core.feed(chunk);
        for (const cmd of out.commands) emu?.serial0_send(`${cmd}\n`);
        feedCount++;
        setFeeds(feedCount);
        // 4. Render the reconstructed state.
        const snap = core.snapshot();
        setPanes(snap.panes);
      });

      // 5. Attach the control client + give it a size (a control client with no
      //    size never gets a %layout-change).
      setTimeout(() => {
        if (disposed || !emu) return;
        setStatus('attaching tmux -CC…');
        attached = true;
        emu.serial0_send(ATTACH);
        setStatus('control mode live (rust wasm core)');
        setTimeout(() => emu?.serial0_send('refresh-client -C 80x24\n'), 1000);
      }, 1500);
    })();

    return () => {
      disposed = true;
      if (emu?.destroy) emu.destroy().catch(() => {});
      else emu?.stop?.().catch(() => {});
    };
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: 12, background: '#0f0f12', color: '#d8d8e0' }}>
      <div style={{ marginBottom: 8 }}>
        <strong>real tmux -CC → tmuxy-core WASM</strong> — status:{' '}
        <span data-testid="tmux-status">{status}</span>
        {'  ·  '}feeds: <span data-testid="tmux-feeds">{feeds}</span>
      </div>
      <div
        data-testid="tmux-panes"
        style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 100 }}
      >
        {panes.length === 0 && (
          <em style={{ opacity: 0.6 }}>(waiting for state from rust core…)</em>
        )}
        {panes.map((p) => (
          <div
            key={p.tmux_id}
            data-pane-id={p.tmux_id}
            style={{
              border: '1px solid #3a3a44',
              padding: '4px 8px',
              background: '#16161c',
              width: 340,
            }}
          >
            pane {p.tmux_id} — {p.width}×{p.height} @ {p.x},{p.y}
          </div>
        ))}
      </div>
      <pre
        data-testid="raw-serial"
        style={{
          marginTop: 10,
          height: 180,
          overflow: 'auto',
          background: '#000',
          color: '#6f6',
          fontSize: 11,
          padding: 6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {raw || '(no serial yet)'}
      </pre>
    </div>
  );
}

const meta: Meta<typeof V86TmuxWasmConsole> = {
  title: 'Spikes/v86 tmux Control Mode',
  component: V86TmuxWasmConsole,
  tags: ['spike'],
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof V86TmuxWasmConsole>;

export const RealTmuxRustWasm: Story = {
  play: async ({ canvasElement }) => {
    // The snapshot has a 2-pane session; the REAL Rust core must reconstruct
    // >=2 panes from the live control-mode stream.
    await waitFor(
      () => {
        const panes = canvasElement.querySelectorAll('[data-pane-id]');
        expect(panes.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 45000, interval: 500 },
    );
    const feeds = Number(
      canvasElement.querySelector('[data-testid="tmux-feeds"]')?.textContent ?? '0',
    );
    expect(feeds).toBeGreaterThan(0);
  },
};
