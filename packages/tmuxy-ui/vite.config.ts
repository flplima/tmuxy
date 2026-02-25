import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // When accessed through the Rust proxy (port 3853), HMR connects directly to Vite
    hmr: {
      port: 1420,
      clientPort: 1420,
    },
},
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
