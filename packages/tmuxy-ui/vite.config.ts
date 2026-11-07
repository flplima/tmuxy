import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 9001,
    strictPort: true,
    // When accessed through the Rust proxy (`tmuxy-server --dev`), HMR connects
    // directly to Vite. The port is tmuxy-core's DEV_VITE_PORT (tests/dev_ports.rs).
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
