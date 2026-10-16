import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { version } from './package.json';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // What Help ▸ About shows; the version bump touches package.json already.
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: {
    port: 9001,
    strictPort: true,
    // When accessed through the Rust proxy (port 9000), HMR connects directly to Vite
    hmr: {
      port: 9001,
      clientPort: 9001,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
