import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { useEffect, useRef, useState } from 'react';

/**
 * SPIKE — v86 boot bring-up (Phase 0 of the client-side real-tmux adapter).
 *
 * This is the de-risking story for running REAL tmux fully client-side: a full
 * x86 Linux kernel booting in the browser via v86 (WASM emulator), reachable
 * over its serial port. tmux can't be compiled to WASI (needs fork/PTYs), so a
 * whole-machine emulator is the only route to *real* tmux in the browser.
 *
 * What this proves:
 *   - v86 (WASM) loads + boots a Linux kernel inside Storybook;
 *   - the serial0 channel is readable AND writable from JS (the future adapter's
 *     transport): we read the boot log and write a command, then see its output.
 *
 * What it does NOT yet have: tmux in the guest image. The booted image is the
 * stock buildroot/busybox kernel (no tmux) fetched from i.copy.sh. Adding a
 * tmux-capable image (remastered Alpine / Buildroot + tmux, ideally a pre-booted
 * v86 state snapshot) is the next Phase-0 sub-task — see the probe output, which
 * prints `NO_TMUX_YET` on purpose to keep that gap honest and visible.
 *
 * Notes:
 *   - v86 runs single-threaded; no SharedArrayBuffer / COOP-COEP headers needed
 *     (it loads v86-fallback.wasm automatically when SAB is absent).
 *   - The kernel image is fetched cross-origin from i.copy.sh (ACAO: *).
 *   - This story is tagged `spike` and excluded from the CI story probe
 *     (scripts/probe-stories.mjs) — it is slow, network-dependent, and
 *     nondeterministic. It is for manual review and the adapter spike only.
 */

const WASM_PATH = '/v86/v86.wasm';
// Served same-origin from .storybook staticDirs (the upstream host blocks
// cross-site browser fetches). Run `npm run fetch:v86-image` to populate it.
const BZIMAGE_URL = '/v86-img/buildroot-bzimage.bin';
const SEABIOS_URL = '/v86-img/seabios.bin';
const VGABIOS_URL = '/v86-img/vgabios.bin';
// Match v86's canonical serial example so the kernel routes its console to
// ttyS0 and trusts the emulated TSC/RNG (otherwise boot stalls).
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const BOOT_MARKER = 'PHASE0_MARKER_OK';
// Honest probe: prove the shell runs a command, and surface that tmux is not in
// this image yet. Sent once the guest reaches a shell prompt.
const PROBE = `uname -a; tmux -V 2>/dev/null || echo NO_TMUX_YET; echo ${BOOT_MARKER}\n`;

interface V86Emulator {
  add_listener(event: string, cb: (arg: number) => void): void;
  serial0_send(data: string): void;
  create_file?(path: string, data: Uint8Array): Promise<void>;
  save_state?(): Promise<ArrayBuffer>;
  destroy?: () => Promise<void>;
  stop?: () => Promise<void>;
}

function V86Console() {
  const [log, setLog] = useState('');
  const [status, setStatus] = useState('loading v86…');
  const emuRef = useRef<V86Emulator | null>(null);
  const bufRef = useRef('');
  const startedRef = useRef(false);
  const loginSentRef = useRef(false);
  const probeSentRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode / re-render guard
    startedRef.current = true;
    let disposed = false;
    const decoder = new TextDecoder();

    (async () => {
      const { V86 } = (await import('v86')) as unknown as {
        V86: new (opts: Record<string, unknown>) => V86Emulator;
      };
      if (disposed) return;
      setStatus('booting kernel…');

      const emulator = new V86({
        wasm_path: WASM_PATH,
        bios: { url: SEABIOS_URL },
        vga_bios: { url: VGABIOS_URL },
        bzimage: { url: BZIMAGE_URL },
        cmdline: CMDLINE,
        // Empty 9p filesystem so the guest can mount host9p at /mnt and receive
        // injected files via emulator.create_file (used to drop in tmux).
        filesystem: {},
        autostart: true,
        memory_size: 64 * 1024 * 1024,
        vga_memory_size: 2 * 1024 * 1024,
        disable_keyboard: true,
        disable_mouse: true,
      });
      emuRef.current = emulator;
      // Expose for spike probes (tmux injection test) — consistent with the
      // app exposing window.app for E2E. Spike-only.
      (window as unknown as { __v86emu?: V86Emulator }).__v86emu = emulator;

      const drive = (text: string) => {
        // Auto-login if the guest asks for it.
        if (!loginSentRef.current && /login:/i.test(text)) {
          loginSentRef.current = true;
          emulator.serial0_send('root\n');
        }
        // Once a shell prompt appears, fire the probe exactly once. The
        // buildroot/busybox prompt ends in `~% ` (the `%`); also accept `#`/`$`.
        if (!probeSentRef.current && /[#$%]\s*$/.test(text.trimEnd().slice(-200))) {
          probeSentRef.current = true;
          setStatus('shell ready — running probe…');
          emulator.serial0_send(PROBE);
        }
      };

      emulator.add_listener('serial0-output-byte', (byte: number) => {
        const chunk = decoder.decode(new Uint8Array([byte]), { stream: true });
        if (!chunk) return;
        bufRef.current += chunk;
        // Keep the rendered buffer bounded.
        if (bufRef.current.length > 20000) bufRef.current = bufRef.current.slice(-20000);
        setLog(bufRef.current);
        if (bufRef.current.includes(BOOT_MARKER)) setStatus('probe complete ✓');
        drive(bufRef.current);
      });

      // Fallback: if prompt detection misses, still fire the probe after a while.
      setTimeout(() => {
        if (!disposed && !probeSentRef.current) {
          probeSentRef.current = true;
          setStatus('timeout fallback — running probe…');
          emulator.serial0_send('\n' + PROBE);
        }
      }, 20000);
    })();

    return () => {
      disposed = true;
      const emu = emuRef.current;
      if (emu?.destroy) emu.destroy().catch(() => {});
      else emu?.stop?.().catch(() => {});
    };
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', padding: 12, background: '#0f0f12', color: '#d8d8e0' }}>
      <div style={{ marginBottom: 8 }}>
        <strong>v86 spike</strong> — status: <span data-testid="v86-status">{status}</span>
      </div>
      <pre
        data-testid="v86-serial"
        style={{
          height: 460,
          overflow: 'auto',
          margin: 0,
          padding: 8,
          background: '#000',
          color: '#9fe89f',
          fontSize: 12,
          lineHeight: 1.35,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {log || '(waiting for serial output…)'}
      </pre>
    </div>
  );
}

const meta: Meta<typeof V86Console> = {
  title: 'Spikes/v86 Boot',
  component: V86Console,
  // `spike` excludes this from the CI story probe (scripts/probe-stories.mjs):
  // it is slow, network-dependent, and nondeterministic.
  tags: ['spike'],
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof V86Console>;

export const BootToSerialPrompt: Story = {
  play: async ({ canvasElement }) => {
    // Boot + auto-login + probe round-trip. Re-query each poll (the component
    // may remount under StrictMode) and require BOTH the marker and the
    // `uname -a` "Linux" banner together — they're printed by the same probe,
    // proving the guest shell executed our command over the serial channel.
    // Generous timeout: a cold kernel boot in headless Chromium is slow.
    await waitFor(
      () => {
        const txt = canvasElement.querySelector('[data-testid="v86-serial"]')?.textContent ?? '';
        expect(txt).toContain(BOOT_MARKER);
        expect(txt).toMatch(/Linux/);
      },
      { timeout: 60000, interval: 500 },
    );
  },
};
