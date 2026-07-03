#!/usr/bin/env node
/**
 * Fetch the v86 guest assets for the `Spikes/v86 Boot` story into the
 * gitignored `v86-assets/` dir, served same-origin by Storybook (.storybook
 * staticDirs). These binaries are NOT committed — run this once before opening
 * the spike story:  `npm run fetch:v86-image -w tmuxy-ui`
 *
 * Why same-origin: the upstream image host blocks cross-site *browser* fetches
 * via Referer checks, so v86 can't fetch them directly from the Storybook page.
 * Server-side fetch (here) has no Referer and is allowed.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'v86-assets');

// kernel: buildroot busybox bzImage (boots to a serial shell, ~5 MB).
// bios: committed in the v86 repo (the npm package omits them).
const ASSETS = [
  { name: 'buildroot-bzimage.bin', url: 'https://i.copy.sh/buildroot-bzimage.bin' },
  { name: 'seabios.bin', url: 'https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin' },
  { name: 'vgabios.bin', url: 'https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin' },
];

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

await mkdir(OUT, { recursive: true });
for (const { name, url } of ASSETS) {
  const dest = join(OUT, name);
  if (await exists(dest)) {
    console.log(`✓ ${name} (already present)`);
    continue;
  }
  process.stdout.write(`↓ ${name} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log('done');
}
console.log(`\nv86 assets ready in ${OUT}`);
