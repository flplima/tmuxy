// The demo runs real tmux in a v86 guest, which loads its pieces at runtime
// from the site's own origin: the emulator (/v86), the guest's BIOS,
// kernel and pre-booted snapshot (/v86-img) and the tmuxy-core engine
// compiled to wasm (/wasm). This copies them into public/ for `next dev` and
// the static export. None is in git; each is built by the command named in
// the error, which is what the Deploy Demo workflow runs first.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const publicDir = join(here, '..', 'public');
const v86Build = join(dirname(createRequire(import.meta.url).resolve('v86/package.json')), 'build');
const guest = join(repo, 'packages', 'tmuxy-ui', 'v86-assets');
const wasm = join(repo, 'packages', 'tmuxy-wasm', 'pkg');

const SETS = [
  { to: 'v86', from: v86Build, files: ['libv86.mjs', 'v86.wasm'], build: 'npm ci' },
  {
    to: 'v86-img',
    from: guest,
    // The snapshot goes gzipped only: the engine inflates it in the page.
    files: ['seabios.bin', 'vgabios.bin', 'buildroot-bzimage.bin', 'tmux-state.bin.gz'],
    build: 'npm run fetch:v86-image -w tmuxy-ui && npm run build:v86-snapshot -w tmuxy-ui',
  },
  {
    to: 'wasm',
    from: wasm,
    files: ['tmuxy_wasm.js', 'tmuxy_wasm_bg.wasm'],
    build: 'npm run build:wasm',
  },
];

const missing = SETS.flatMap((set) =>
  set.files
    .filter((file) => !existsSync(join(set.from, file)))
    .map((file) => `  ${join(set.from, file)}  (${set.build})`),
);
if (missing.length > 0) {
  console.error(`The demo's v86 assets are missing:\n${missing.join('\n')}`);
  process.exit(1);
}

for (const set of SETS) {
  const dir = join(publicDir, set.to);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const file of set.files) copyFileSync(join(set.from, file), join(dir, file));
}
console.log(`staged the v86 assets into ${publicDir}`);
