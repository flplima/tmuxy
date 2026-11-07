import { defineConfig } from 'vite';

// The e-ink page (src/kindle/), built on its own after the app: its target is
// the Kindle Scribe's browser, Silk 80 (Chrome 80), which the app's bundle is
// too new for. esbuild lowers the syntax and fails the build on any it cannot.
// Into the app's dist/, beside it, so the server embeds both.
export default defineConfig({
  build: {
    target: 'chrome80',
    emptyOutDir: false,
    rollupOptions: {
      input: 'kindle.html',
    },
  },
});
