#!/usr/bin/env node
/**
 * Build the CheerpX guest image, `cheerpx-assets/tmuxy.ext2`: 32-bit Alpine
 * with bash, tmux built from source (every `cheerpx/patches/*.patch` applied),
 * the repo's `tmuxy` CLI and scripts, the shipped tmux config, the i686
 * `tmuxy-group` and `tmuxy-pty`, the terminal each pane runs on — see
 * cheerpx/Dockerfile for the guest layout.
 *
 * Needs Docker with linux/386 emulation (binfmt; Docker Desktop and Colima
 * have it) and the i686-unknown-linux-musl Rust target. Usage, from
 * packages/tmuxy-ui:
 *
 *   node scripts/build-cheerpx-image.mjs            # tmux 3.7c
 *   TMUX_VERSION=3.6a node scripts/build-cheerpx-image.mjs
 */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  crossCompileGuestBinaries,
  GUEST_CONF_ASSETS,
  GUEST_CONF_ASSETS_DIR,
  guestBashrc,
  guestTmuxyConf,
  guestEntryConf,
  GUEST_CONFIG_DIR,
  GUEST_DATA_DIR,
  stageTmuxyScripts,
} from './lib/guest.mjs';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHEERPX = join(UI, 'cheerpx');
const ASSETS = join(UI, 'cheerpx-assets');
const CONTEXT = join(ASSETS, '.context');
const GUEST = join(CONTEXT, 'guest');

await rm(CONTEXT, { recursive: true, force: true });
await mkdir(join(CONTEXT, 'patches'), { recursive: true });
await cp(join(CHEERPX, 'Dockerfile'), join(CONTEXT, 'Dockerfile'));
// The preload tmuxy-pty runs pane programs with, compiled in the image.
await cp(join(UI, '..', 'tmuxy-pty', 'preload.c'), join(CONTEXT, 'preload.c'));
await cp(join(CHEERPX, 'patches'), join(CONTEXT, 'patches'), { recursive: true }).catch(
  () => undefined,
);

// The guest tree, overlaid on the Alpine root by the Dockerfile: the files
// kept in cheerpx/rootfs, then what is built or copied from the repo.
await cp(join(CHEERPX, 'rootfs'), GUEST, { recursive: true });
await crossCompileGuestBinaries(['tmuxy-group', 'tmuxy-pty'], join(GUEST, 'usr', 'bin'));
await stageTmuxyScripts(join(GUEST, 'opt', 'tmuxy', 'bin'));
const config = join(GUEST, GUEST_CONFIG_DIR);
const data = join(GUEST, GUEST_DATA_DIR);
await mkdir(config, { recursive: true });
await mkdir(data, { recursive: true });
for (const conf of GUEST_CONF_ASSETS) {
  await cp(join(GUEST_CONF_ASSETS_DIR, conf), join(data, conf));
}
await writeFile(join(data, 'tmuxy.entry.conf'), guestEntryConf());
// A pane runs on a socket pair (patches/pane-socketpair.patch), so bash is
// asked to be interactive and leaves line editing to tmuxy-pty.
await writeFile(join(config, 'tmuxy.conf'), guestTmuxyConf('exec /bin/bash --noediting -i'));
// The pane shell's ~/.bashrc. CheerpX cannot set a hostname, so the prompt
// names the host itself. tmux cannot see a pane's directory, so the prompt
// reports it with OSC 7 (patches/pane-path-from-osc7.patch): tab names and
// splits follow `cd`. And a shell started bare in a pane, which is no
// terminal, would not know it is interactive and print no prompt (and ash,
// without +m, would warn that it has no tty for job control).
const PANE_BASHRC = [
  `PROMPT_COMMAND='printf "\\033]7;%s\\007" "$PWD"'`,
  'bash() { if [ $# -eq 0 ]; then command bash --noediting -i; else command bash "$@"; fi; }',
  'sh() { if [ $# -eq 0 ]; then command sh +m -i; else command sh "$@"; fi; }',
  '',
].join('\n');
await writeFile(join(GUEST, 'root', '.bashrc'), `${guestBashrc('tmuxy')}${PANE_BASHRC}`);

console.log('… docker build (tmux from source under linux/386 emulation; minutes on first run)');
const buildArgs = process.env.TMUX_VERSION
  ? ['--build-arg', `TMUX_VERSION=${process.env.TMUX_VERSION}`]
  : [];
const TAG = 'tmuxy-cheerpx-guest';
execFileSync(
  'docker',
  ['build', ...buildArgs, '-t', TAG, '-f', join(CONTEXT, 'Dockerfile'), CONTEXT],
  { stdio: 'inherit' },
);

// The guest's root leaves Docker as a tar stream (`docker export`), and a
// native throwaway container packs it (cheerpx/pack.sh) — streams both ways,
// so the build needs neither BuildKit nor a bind mount.
console.log('… exporting the root filesystem and packing it as ext2');
const container = execFileSync('docker', ['create', TAG]).toString().trim();
const rootfsTar = join(ASSETS, '.rootfs.tar');
try {
  execFileSync('docker', ['export', '-o', rootfsTar, container]);
} finally {
  execFileSync('docker', ['rm', container], { stdio: 'ignore' });
}
const pack = await readFile(join(CHEERPX, 'pack.sh'), 'utf8');
const image = execFileSync('docker', ['run', '-i', '--rm', 'alpine:3.22', 'sh', '-c', pack], {
  input: await readFile(rootfsTar),
  maxBuffer: 1 << 30,
  stdio: ['pipe', 'pipe', 'inherit'],
});
await writeFile(join(ASSETS, 'tmuxy.ext2'), image);
await rm(rootfsTar, { force: true });
await rm(CONTEXT, { recursive: true, force: true });
const size = (await stat(join(ASSETS, 'tmuxy.ext2'))).size;
console.log(`✓ cheerpx-assets/tmuxy.ext2 written (${(size / 1e6).toFixed(1)} MB)`);
