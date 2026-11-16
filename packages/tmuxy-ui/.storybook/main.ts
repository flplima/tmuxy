import type { StorybookConfig } from '@storybook/react-vite';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The installed v86 build dir, wherever npm hoisted it. Storybook loads this
// config as ESM, hence createRequire.
const nodeRequire = createRequire(import.meta.url);
const v86Build = join(dirname(nodeRequire.resolve('v86/package.json')), 'build');

// The v86 guest kernel image, served same-origin from a gitignored cache dir:
// the upstream host blocks cross-site browser fetches by Referer. Populate it
// with `npm run fetch:v86-image`.
const v86Images = join(dirname(fileURLToPath(import.meta.url)), '..', 'v86-assets');

// tmuxy-core compiled to wasm (`npm run build:wasm`), served at /wasm.
const wasmPkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmuxy-wasm', 'pkg');

// The app serves public/themes from Vite's public dir; Storybook mounts them
// so the theme switcher can load /themes/<name>.css.
const themesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'themes');

// Behind a reverse proxy that serves the app at / and Storybook under a path
// prefix on one port (bin/sandbox), STORYBOOK_BASE names that prefix
// (`/storybook/`). Vite then writes the prefix into every module URL the preview
// loads, and its HMR client dials the port the page came from instead of
// Storybook's own.
const proxyBase = process.env.STORYBOOK_BASE;

// Host names the proxy is reached by, comma separated, for when it is not
// localhost or an IP address.
const proxyHosts = process.env.STORYBOOK_ALLOWED_HOSTS?.split(',').filter(Boolean);

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
  ...(proxyHosts && { core: { allowedHosts: proxyHosts } }),
  ...(proxyBase && {
    viteFinal: (viteConfig) => {
      const { port: _builderPort, ...hmr } =
        typeof viteConfig.server?.hmr === 'object' ? viteConfig.server.hmr : {};
      return { ...viteConfig, base: proxyBase, server: { ...viteConfig.server, hmr } };
    },
  }),
};

export default config;
