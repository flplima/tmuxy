#!/usr/bin/env node
/**
 * Build the v86 guest assets for the client-side tmuxy stories/demo:
 *
 *   1. tmux-bundle.tar — i686-musl tmux 3.7a + bash + libs (reused from the
 *      existing bundle, or fetched from Alpine with --fetch-binaries) overlaid
 *      with the CURRENT repo `bin/tmuxy*` scripts, tmux config (defaults incl.
 *      command-aliases + bindings), and a standard bash prompt.
 *   2. tmux-state.bin — a pre-booted machine snapshot: kernel booted, bundle
 *      installed at /tmp/tb with system symlinks, config at ~/.config/tmuxy,
 *      and a live `m` session (2 panes, window "root") ready for
 *      `tmux -CC attach`. Boot in the browser restores this in ~1s.
 *
 * Runs v86 headlessly in Node (no browser). Usage, from packages/tmuxy-ui:
 *
 *   npm run fetch:v86-image          # kernel + BIOS (once)
 *   node scripts/build-v86-snapshot.mjs [--fetch-binaries]
 *
 * Because everything (aliases, script paths, PS1, config) is baked here, the
 * runtime GUEST_SETUP in V86Engine stays empty — snapshot restores rewind the
 * filesystem, so anything NOT baked would have to be re-sent on every reset.
 */
import { mkdir, writeFile, readFile, cp, rm, chmod, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, '..');
const REPO = join(UI, '..', '..');
const ASSETS = join(UI, 'v86-assets');
const BUNDLE_TAR = join(ASSETS, 'tmux-bundle.tar');
const STATE_BIN = join(ASSETS, 'tmux-state.bin');
const WORK = join(ASSETS, '.bundle-root');

// Pinned Alpine x86 packages for --fetch-binaries (binaries are otherwise
// reused from the existing tmux-bundle.tar). Alpine occasionally rotates
// point releases; bump these if a URL 404s.
const ALPINE = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86';
const APKS = [
  'musl-1.2.5-r10.apk',
  'bash-5.2.37-r0.apk',
  'readline-8.2.13-r1.apk',
  'ncurses-terminfo-base-6.5_p20250503-r0.apk',
  'libncursesw-6.5_p20250503-r0.apk',
  'libevent-2.1.12-r7.apk',
  'tmux-3.7a-r0.apk',
];

const exists = (p) =>
  stat(p).then(
    (s) => s.size > 0,
    () => false,
  );

// ─────────────────────────── 1. Assemble the bundle ───────────────────────────

async function buildBundle({ fetchBinaries }) {
  // node's fs.rm races the bind-mount (virtiofs) — the external rm doesn't.
  execFileSync('rm', ['-rf', WORK]);
  await mkdir(WORK, { recursive: true });

  if (!fetchBinaries && (await exists(BUNDLE_TAR))) {
    // Reuse the proven binaries/terminfo from the current bundle — selectively,
    // so stray legacy entries (e.g. an unreadable root ./tmuxy wrapper) can't
    // fail the extraction. Everything repo-derived is overlaid fresh below.
    execFileSync('tar', [
      '-xf', BUNDLE_TAR, '-C', WORK,
      './tmux', './bash', './ld-musl-i386.so.1',
      './libncursesw.so.6', './libevent_core-2.1.so.7', './libreadline.so.8',
      './terminfo',
    ]);
  } else {
    for (const apk of APKS) {
      const url = `${ALPINE}/${apk}`;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const tmp = join(WORK, apk);
      await writeFile(tmp, buf);
      // .apk is a gzipped tar; extraction warnings about apk metadata are benign.
      try {
        execFileSync('tar', ['-xzf', tmp, '-C', WORK], { stdio: 'pipe' });
      } catch {
        /* apk signature segments produce non-fatal tar warnings */
      }
      await rm(tmp);
    }
    // Flatten the apk tree into the bundle layout the engine expects.
    const moves = [
      ['lib/ld-musl-i386.so.1', 'ld-musl-i386.so.1'],
      ['bin/bash', 'bash'],
      ['usr/bin/tmux', 'tmux'],
      ['usr/lib/libncursesw.so.6', 'libncursesw.so.6'],
      ['usr/lib/libevent_core-2.1.so.7', 'libevent_core-2.1.so.7'],
      ['usr/lib/libreadline.so.8', 'libreadline.so.8'],
      ['etc/terminfo', 'terminfo'],
    ];
    for (const [from, to] of moves) {
      await cp(join(WORK, from), join(WORK, to), { recursive: true, dereference: true });
    }
    for (const d of ['lib', 'bin', 'usr', 'etc', 'sbin', 'var']) {
      await rm(join(WORK, d), { recursive: true, force: true });
    }
  }

  // The real sidebar tree TUI, cross-compiled static for the i686 guest so
  // `tmuxy tree` works without the tmuxy-server binary.
  console.log('… cross-compiling tmuxy-tree (i686-musl)');
  execFileSync(
    'cargo',
    ['build', '-p', 'tmuxy-tree', '--bin', 'tmuxy-tree', '--target', 'i686-unknown-linux-musl', '--release'],
    { cwd: REPO, env: { ...process.env, RUSTFLAGS: '-C linker=rust-lld -C target-feature=+crt-static' }, stdio: 'pipe' },
  );
  await cp(join(REPO, 'target', 'i686-unknown-linux-musl', 'release', 'tmuxy-tree'), join(WORK, 'tmuxy-tree'));
  await chmod(join(WORK, 'tmuxy-tree'), 0o755);

  // Fresh repo scripts: the CLI dispatcher + helper scripts.
  await mkdir(join(WORK, 'bin', 'tmuxy'), { recursive: true });
  await cp(join(REPO, 'bin', 'tmuxy-cli'), join(WORK, 'bin', 'tmuxy-cli'));
  for (const f of await readdir(join(REPO, 'bin', 'tmuxy'))) {
    await cp(join(REPO, 'bin', 'tmuxy', f), join(WORK, 'bin', 'tmuxy', f));
    await chmod(join(WORK, 'bin', 'tmuxy', f), 0o755);
  }
  await chmod(join(WORK, 'bin', 'tmuxy-cli'), 0o755);

  // Fresh config: the same defaults the devcontainer uses (command-aliases,
  // Ctrl+hjkl nav bindings, prefix bindings) + a minimal user conf sourcing it.
  await cp(join(REPO, '.devcontainer', '.tmuxy.defaults.conf'), join(WORK, 'tmuxy.defaults.conf'));
  await writeFile(
    join(WORK, 'tmuxy.conf'),
    [
      '# Guest user config — defaults shipped by tmuxy, edit freely.',
      'source-file ~/.config/tmuxy/tmuxy.defaults.conf',
      '# Non-login interactive bash: skips the buildroot /etc/profile boot',
      "# banner + its PS1 override, and reads ~/.bashrc (standard prompt).",
      'set -g default-command /bin/bash',
      '',
    ].join('\n'),
  );

  // Standard interactive prompt (the buildroot busybox default was `root%`).
  await writeFile(join(WORK, 'bashrc'), "export PS1='\\u@\\h:\\w\\$ '\n");

  await rm(BUNDLE_TAR, { force: true });
  execFileSync('tar', ['-cf', BUNDLE_TAR, '-C', WORK, '.']);
  execFileSync('rm', ['-rf', WORK]);
  const size = (await stat(BUNDLE_TAR)).size;
  console.log(`✓ tmux-bundle.tar rebuilt (${(size / 1e6).toFixed(1)} MB)`);
}

// ─────────────────────────── 2. Boot + snapshot ───────────────────────────

// The in-guest install script. Everything is baked into the snapshot so the
// engine's runtime bootstrap can stay empty. Steps mirror what the browser
// engine used to hot-patch: loader/lib/bin symlinks, script path, config, PS1.
const GUEST_INSTALL = [
  'mkdir -p /dev/pts && mount -t devpts devpts /dev/pts',
  'mkdir -p /mnt && mount -t 9p host9p /mnt',
  'mkdir -p /tmp/tb && tar -xf /mnt/tmux-bundle.tar -C /tmp/tb',
  'ln -sf /tmp/tb/ld-musl-i386.so.1 /lib/ld-musl-i386.so.1',
  'for f in /tmp/tb/lib*.so*; do ln -sf $f /lib/; done',
  'ln -sf /tmp/tb/bash /bin/bash',
  'ln -sf /tmp/tb/tmux /usr/bin/tmux',
  'ln -sf /tmp/tb/bin/tmuxy-cli /usr/bin/tmuxy',
  'ln -sf /tmp/tb/tmuxy-tree /usr/bin/tmuxy-tree',
  'mkdir -p /root/.config/tmuxy/bin',
  'ln -sfn /tmp/tb/bin/tmuxy /root/.config/tmuxy/bin/tmuxy',
  'cp /tmp/tb/tmuxy.conf /tmp/tb/tmuxy.defaults.conf /root/.config/tmuxy/',
  'cp /tmp/tb/bashrc /root/.bashrc',
  'hostname tmuxy',
  'export HOME=/root SHELL=/bin/bash TERM=xterm-256color TERMINFO=/tmp/tb/terminfo',
  'cd /root',
  '/usr/bin/tmux -f /root/.config/tmuxy/tmuxy.conf new-session -d -s m -x 80 -y 24',
  '/usr/bin/tmux rename-window -t m: root',
  '/usr/bin/tmux split-window -h -t m:',
  'echo SNAPSHOT_IS_READY',
];

async function buildSnapshot() {
  const nodeRequire = createRequire(import.meta.url);
  const v86dir = dirname(nodeRequire.resolve('v86/package.json'));
  const { V86 } = await import(join(v86dir, 'build', 'libv86.mjs'));

  const emulator = new V86({
    wasm_path: join(v86dir, 'build', 'v86.wasm'),
    bios: { url: join(ASSETS, 'seabios.bin') },
    vga_bios: { url: join(ASSETS, 'vgabios.bin') },
    bzimage: { url: join(ASSETS, 'buildroot-bzimage.bin') },
    cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on',
    filesystem: {},
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    disable_keyboard: true,
    disable_mouse: true,
    autostart: true,
  });

  let serial = '';
  emulator.add_listener('serial0-output-byte', (byte) => {
    serial += String.fromCharCode(byte);
  });
  const waitFor = (marker, timeoutMs) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (serial.includes(marker)) {
          clearInterval(iv);
          resolve(undefined);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error(`timeout waiting for ${marker}\n--- serial tail ---\n${serial.slice(-800)}`));
        }
      }, 200);
    });
  // Byte-paced writes: the emulated 16550 FIFO drops bytes on whole-line pushes
  // (same constraint as the browser engine).
  const type = async (line) => {
    for (const ch of `${line}\n`) {
      emulator.serial0_send(ch);
      await new Promise((r) => setTimeout(r, 3));
    }
  };

  console.log('… booting guest kernel');
  await waitFor('~% ', 90_000).catch(async () => {
    // Some buildroot images prompt differently; fall back to probing.
    await type('echo BOOT_PROBE_OK');
    await waitFor('BOOT_PROBE_OK', 30_000);
  });

  console.log('… installing bundle + starting tmux session');
  emulator.create_file('tmux-bundle.tar', new Uint8Array(await readFile(BUNDLE_TAR)));
  await new Promise((r) => setTimeout(r, 500));
  for (const cmd of GUEST_INSTALL) await type(cmd);
  await waitFor('SNAPSHOT_IS_READY', 120_000);

  // Let tmux settle (server up, panes spawned) before freezing the machine.
  await new Promise((r) => setTimeout(r, 3000));

  console.log('… saving machine state');
  const state = await emulator.save_state();
  await writeFile(STATE_BIN, Buffer.from(state));
  const size = (await stat(STATE_BIN)).size;
  console.log(`✓ tmux-state.bin written (${(size / 1e6).toFixed(1)} MB)`);
  await emulator.destroy?.();
  process.exit(0);
}

const fetchBinaries = process.argv.includes('--fetch-binaries');
if (!(await exists(join(ASSETS, 'buildroot-bzimage.bin')))) {
  console.error('kernel missing — run `npm run fetch:v86-image` first');
  process.exit(1);
}
await buildBundle({ fetchBinaries });
await buildSnapshot();
