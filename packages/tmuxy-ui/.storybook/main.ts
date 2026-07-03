import type { StorybookConfig } from '@storybook/react-vite';
import type { UserConfig } from 'vite';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Resolve the installed v86 build dir (wasm + libv86) robustly, regardless of
// npm hoisting, so the v86 spike story can fetch /v86/v86.wasm at runtime.
// Storybook loads this config as ESM, so use createRequire for resolution.
const nodeRequire = createRequire(import.meta.url);
const v86Build = join(dirname(nodeRequire.resolve('v86/package.json')), 'build');

// The v86 guest kernel image is served same-origin from a gitignored cache dir
// (the upstream host blocks cross-site browser fetches via Referer checks).
// Populate it with `npm run fetch:v86-image` before opening the spike story.
const v86Images = join(dirname(fileURLToPath(import.meta.url)), '..', 'v86-assets');

// tmuxy-wasm: the tmuxy-core control-mode parser + state aggregator compiled to
// WASM. Served at /wasm so the v86 story can parse real tmux control mode with
// the same Rust logic the native server uses. Build via `npm run build:wasm`.
const wasmPkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmuxy-wasm', 'pkg');

// The bundled theme stylesheets (public/themes/*.css). The real app serves these
// from Vite's public dir; Storybook needs them mounted explicitly so the x86
// client's theme switcher can load /themes/<name>.css (otherwise the light/dark
// and named-theme switches have no stylesheet to apply).
const themesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'themes');

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  staticDirs: [
    { from: v86Build, to: '/v86' },
    { from: v86Images, to: '/v86-img' },
    { from: wasmPkg, to: '/wasm' },
    { from: themesDir, to: '/themes' },
  ],
  typescript: {
    reactDocgen: false,
  },
  // v86 is a large, hand-written ESM module that loads its own wasm at runtime;
  // let Vite serve it as-is instead of pre-bundling it through esbuild.
  viteFinal: async (cfg: UserConfig) => {
    cfg.optimizeDeps = cfg.optimizeDeps ?? {};
    cfg.optimizeDeps.exclude = [...(cfg.optimizeDeps.exclude ?? []), 'v86'];
    return cfg;
  },
};

export default config;
