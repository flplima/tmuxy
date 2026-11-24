#!/usr/bin/env node
/**
 * Build the v86 guest assets for the client-side tmuxy stories/demo:
 *
 *   1. tmux-bundle.tar — i686-musl tmux 3.7a + bash + libs (reused from the
 *      existing bundle, or fetched from Alpine with --fetch-binaries) overlaid
 *      with the CURRENT repo `bin/tmuxy*` scripts, tmux config (defaults incl.
 *      command-aliases + bindings), and a standard bash prompt.
 *   2. tmux-state.bin — a pre-booted machine snapshot: kernel booted, bundle
 *      installed at /tmp/tb with system symlinks, the shipped config and
 *      scripts in ~/.local/share/tmuxy, the user's in ~/.config/tmuxy,
 *      and a live `m` session (2 panes, window "root") ready for
 *      `tmux -CC attach`. Boot in the browser restores this in ~1s. The
 *      stories start from it.
 *   3. demo-state.bin — the same machine carried on, with the demo's showcase
 *      built in it (`demo-showcase/showcase.sh`): what the demo site restores,
 *      so a visitor's first frame is the finished layout.
 *
 * The states' file names and the session each one holds are
 * `src/infra/transport/drivers/v86/snapshots.json`, which the page reads too.
 *
 * Runs v86 headlessly in Node (no browser). Usage, from packages/tmuxy-ui:
 *
 *   npm run fetch:v86-image          # kernel + BIOS (once)
 *   node scripts/build-v86-snapshot.mjs [--fetch-binaries]
 *
 * Everything (aliases, script paths, PS1, config) is baked here because a
 * snapshot restore rewinds the filesystem: anything not baked would have to be
 * re-sent on every reset.
 */
import { mkdir, writeFile, readFile, readdir, cp, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { constants, zstdCompressSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  crossCompileGuestBinaries,
  GUEST_CONF_ASSETS,
  GUEST_CONF_ASSETS_DIR,
  guestBashrc,
  guestTmuxyConf,
  guestEntryConf,
  GUEST_CONFIG_DIR,
  GUEST_DATA_DIR,
  GUEST_ENTRY_CONF,
  GUEST_STATE_DIR,
  stageTmuxyScripts,
} from './lib/guest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, '..');
const ASSETS = join(UI, 'v86-assets');
const BUNDLE_TAR = join(ASSETS, 'tmux-bundle.tar');
const WORK = join(ASSETS, '.bundle-root');
const SNAPSHOTS = JSON.parse(
  await readFile(join(UI, 'src', 'infra', 'transport', 'drivers', 'v86', 'snapshots.json'), 'utf8'),
);
const GENERIC = SNAPSHOTS.generic.session;
const SHOWCASE = join(HERE, 'demo-showcase');

// Pinned Alpine x86 packages for --fetch-binaries (binaries are otherwise
// reused from the existing tmux-bundle.tar). Alpine rotates point releases
// WITHOUT keeping the old files (the CI cache-miss path then 404s) — bump
// these when a URL dies. tmux comes from a newer release than the rest (v3.22
// ships an older tmux with the control-mode crash bugs documented in
// docs/TMUX.md), and from a numbered release, never edge, which drops a
// version the day it ships the next.
const ALPINE = 'https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86';
const ALPINE_TMUX = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86';
const APKS = [
  `${ALPINE}/musl-1.2.5-r13.apk`,
  `${ALPINE}/bash-5.2.37-r0.apk`,
  `${ALPINE}/readline-8.2.13-r1.apk`,
  `${ALPINE}/ncurses-terminfo-base-6.5_p20250503-r0.apk`,
  `${ALPINE}/libncursesw-6.5_p20250503-r0.apk`,
  `${ALPINE}/libevent-2.1.13-r0.apk`,
  `${ALPINE_TMUX}/tmux-3.7c-r0.apk`,
];

const exists = (p) =>
  stat(p).then(
    (s) => s.size > 0,
    () => false,
  );

async function buildBundle({ fetchBinaries }) {
  // node's fs.rm races the bind-mount (virtiofs) — the external rm doesn't.
  execFileSync('rm', ['-rf', WORK]);
  await mkdir(WORK, { recursive: true });

  if (!fetchBinaries && (await exists(BUNDLE_TAR))) {
    // Reuse the proven binaries/terminfo from the current bundle — selectively,
    // so stray legacy entries (e.g. an unreadable root ./tmuxy wrapper) can't
    // fail the extraction. Everything repo-derived is overlaid fresh below.
    execFileSync('tar', [
      '-xf',
      BUNDLE_TAR,
      '-C',
      WORK,
      './tmux',
      './bash',
      './ld-musl-i386.so.1',
      './libncursesw.so.6',
      './libevent_core-2.1.so.7',
      './libreadline.so.8',
      './terminfo',
    ]);
  } else {
    for (const url of APKS) {
      const res = await fetch(url);
      // Fail loudly — a rotated-away package otherwise surfaces later as a
      // baffling ENOENT when the flatten step can't find the binary.
      if (!res.ok) {
        throw new Error(`APK download failed (${res.status}): ${url} — bump the pin (see APKS)`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = join(WORK, url.split('/').pop());
      await writeFile(tmp, buf);
      // .apk is a gzipped tar; extraction warnings about apk metadata are benign.
      try {
        execFileSync('tar', ['-xzf', tmp, '-C', WORK], { stdio: 'pipe' });
      } catch {
        /* apk signature segments produce non-fatal tar warnings */
      }
      await rm(tmp);
    }
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

  // The verbs the CLI runs in Rust, there being no server (`tmuxy-verbs`),
  // the CLI dispatcher with its helper scripts, and the config the app ships
  // (the essentials hold the `tmuxy-*` command-aliases; without them every
  // Ctrl+h/j/k/l was "unknown command") — all flat in the bundle, placed by
  // GUEST_INSTALL.
  await crossCompileGuestBinaries(['tmuxy-verbs'], WORK);
  await stageTmuxyScripts(join(WORK, 'bin'));
  for (const conf of GUEST_CONF_ASSETS) {
    await cp(join(GUEST_CONF_ASSETS_DIR, conf), join(WORK, conf));
  }
  await writeFile(join(WORK, 'tmuxy.conf'), guestTmuxyConf());
  await writeFile(join(WORK, 'tmuxy.entry.conf'), guestEntryConf());
  await writeFile(join(WORK, 'bashrc'), guestBashrc());

  await rm(BUNDLE_TAR, { force: true });
  execFileSync('tar', ['-cf', BUNDLE_TAR, '-C', WORK, '.']);
  execFileSync('rm', ['-rf', WORK]);
  const size = (await stat(BUNDLE_TAR)).size;
  console.log(`✓ tmux-bundle.tar rebuilt (${(size / 1e6).toFixed(1)} MB)`);
}

// A state is the machine's memory, less the pages that are all zeroes, and
// a visitor downloads it whole. The kernel does not zero a page it frees:
// what the boot and the install leave behind in free memory (the packed
// kernel image, the bundle's tar, every file deleted since) was 40% of the
// download, most of it data that does not compress. `init_on_free` has the
// kernel zero each page as it frees it, from the boot on, so free memory is
// zeroes whenever a state is saved.
const GUEST_CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on init_on_free=1';

// The base image's files that nothing in the guest can use: its own test
// files, and a browser and a downloader in a machine with no network.
const GUEST_UNUSED = ['/root/tests', '/root/test.lua', '/usr/bin/links', '/usr/bin/curl'];

const GUEST_INSTALL = [
  `rm -rf ${GUEST_UNUSED.join(' ')}`,
  'mkdir -p /dev/pts && mount -t devpts devpts /dev/pts',
  'mkdir -p /mnt && mount -t 9p host9p /mnt',
  // The tar leaves the share once unpacked: a state keeps the share's files.
  'mkdir -p /tmp/tb && tar -xf /mnt/tmux-bundle.tar -C /tmp/tb && rm /mnt/tmux-bundle.tar',
  'ln -sf /tmp/tb/ld-musl-i386.so.1 /lib/ld-musl-i386.so.1',
  'for f in /tmp/tb/lib*.so*; do ln -sf $f /lib/; done',
  'ln -sf /tmp/tb/bash /bin/bash',
  'ln -sf /tmp/tb/tmux /usr/bin/tmux',
  'ln -sf /tmp/tb/bin/tmuxy-cli /usr/bin/tmuxy',
  'ln -sf /tmp/tb/tmuxy-verbs /usr/bin/tmuxy-verbs',
  `mkdir -p ${GUEST_CONFIG_DIR} ${GUEST_DATA_DIR}/bin ${GUEST_STATE_DIR}`,
  // busybox's ln has no -n; with it the link was never made, and the
  // essentials' `$TMUXY_DATA_DIR/bin/tmuxy/...` scripts did not exist.
  `ln -sf /tmp/tb/bin/tmuxy ${GUEST_DATA_DIR}/bin/tmuxy`,
  // The CLI where the chain's @tmuxy-cli names it, as the app mirrors it.
  `ln -sf /tmp/tb/bin/tmuxy-cli ${GUEST_DATA_DIR}/bin/tmuxy-cli`,
  `cp ${GUEST_CONF_ASSETS.map((conf) => `/tmp/tb/${conf}`).join(' ')} ${GUEST_DATA_DIR}/`,
  `cp /tmp/tb/tmuxy.entry.conf ${GUEST_STATE_DIR}/`,
  `cp /tmp/tb/tmuxy.conf ${GUEST_CONFIG_DIR}/`,
  'cp /tmp/tb/bashrc /root/.bashrc',
  'hostname tmuxy',
  // LANG reaches every pane's shell through the tmux server's environment.
  'export HOME=/root SHELL=/bin/bash TERM=xterm-256color TERMINFO=/tmp/tb/terminfo LANG=C.UTF-8 LC_ALL=C.UTF-8',
  'cd /root',
  `/usr/bin/tmux -f ${GUEST_ENTRY_CONF} new-session -d -s ${GENERIC} -x 80 -y 24`,
  `/usr/bin/tmux rename-window -t ${GENERIC}: root`,
  `/usr/bin/tmux split-window -h -t ${GENERIC}:`,
  'echo SNAPSHOT_IS_READY',
];

/** The guest's serial console: `type` a line at its shell, `waitFor` text it printed. */
function serialConsole(emulator) {
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
          reject(
            new Error(`timeout waiting for ${marker}\n--- serial tail ---\n${serial.slice(-800)}`),
          );
        }
      }, 200);
    });
  // Paced, as the browser engine's pump is: a burst can fill the guest
  // kernel's tty buffer.
  const type = async (line) => {
    for (const ch of `${line}\n`) {
      emulator.serial0_send(ch);
      await new Promise((r) => setTimeout(r, 3));
    }
  };
  return { type, waitFor };
}

// The raw snapshot dominates the client payload, so the page fetches it as
// zstd and v86's restore_state inflates it. Long-distance matching with a
// 32 MB window finds the repeats across the whole image (the page cache and
// the bundle's copies); a longer window or a higher level gains nothing and
// costs the decoder more memory.
const pack = (state) =>
  zstdCompressSync(Buffer.from(state), {
    params: {
      [constants.ZSTD_c_compressionLevel]: 19,
      [constants.ZSTD_c_windowLog]: 25,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
    },
  });

/** A machine state in v86-assets: packed as `name`, the file the page
 *  fetches (`snapshots.json`), and raw beside it without the `.zst`. */
async function writeState(name, state) {
  const raw = name.replace(/\.zst$/, '');
  await writeFile(join(ASSETS, raw), Buffer.from(state));
  console.log(`✓ ${raw} written (${(state.byteLength / 1e6).toFixed(1)} MB)`);
  const packed = pack(state);
  await writeFile(join(ASSETS, name), packed);
  console.log(`✓ ${name} written (${(packed.length / 1e6).toFixed(1)} MB wire)`);
}

/**
 * Carry the machine on into the demo's state: the showcase's files go in the
 * 9p share (the guest's /mnt), whose files a state keeps, and `showcase.sh`
 * builds the demo's session from the generic one, returning once all of it
 * is on screen. The script leaves the share once it ran: it is nothing a
 * visitor should download.
 */
async function bakeShowcase(emulator, { type, waitFor }) {
  for (const name of await readdir(SHOWCASE)) {
    await emulator.create_file(name, new Uint8Array(await readFile(join(SHOWCASE, name))));
  }
  // The marker is split in the typed line, whose echo would match it.
  await type(
    `bash /mnt/showcase.sh ${GENERIC} ${SNAPSHOTS.demo.session} && rm /mnt/showcase.sh && echo SHOWCASE_""IS_READY`,
  );
  await waitFor('SHOWCASE_IS_READY', 360_000);
}

async function buildSnapshot() {
  const nodeRequire = createRequire(import.meta.url);
  const v86dir = dirname(nodeRequire.resolve('v86/package.json'));
  const { V86 } = await import(join(v86dir, 'build', 'libv86.mjs'));

  const emulator = new V86({
    wasm_path: join(v86dir, 'build', 'v86.wasm'),
    bios: { url: join(ASSETS, 'seabios.bin') },
    vga_bios: { url: join(ASSETS, 'vgabios.bin') },
    bzimage: { url: join(ASSETS, 'buildroot-bzimage.bin') },
    cmdline: GUEST_CMDLINE,
    filesystem: {},
    memory_size: 64 * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    disable_keyboard: true,
    disable_mouse: true,
    autostart: true,
  });
  const serial = serialConsole(emulator);
  const { type, waitFor } = serial;

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
  await writeState(SNAPSHOTS.generic.state, await emulator.save_state());

  console.log("… building the demo's showcase");
  await bakeShowcase(emulator, serial);
  console.log("… saving the demo's machine state");
  await writeState(SNAPSHOTS.demo.state, await emulator.save_state());
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
