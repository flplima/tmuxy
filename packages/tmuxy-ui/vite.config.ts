import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Behind a reverse proxy that serves the app and Vite on one port (bin/sandbox),
// this names the path the proxy sends straight to Vite; the HMR client then
// dials it on the port the page came from.
const proxiedHmrPath = process.env.TMUXY_VITE_HMR_PATH;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 9001,
    strictPort: true,
    // When accessed through the Rust proxy (`tmuxy-server --dev`), HMR connects
    // directly to Vite. The port is tmuxy-core's DEV_VITE_PORT (tests/dev_ports.rs).
    hmr: proxiedHmrPath
      ? { path: proxiedHmrPath }
      : {
          port: 9001,
          clientPort: 9001,
        },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
