import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const isLibBuild = process.env.VITE_LIB === '1'

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
    proxy: {
      '/ws': {
        target: 'http://localhost:3853',
        ws: true,
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  ...(isLibBuild
    ? {
        build: {
          lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
          },
          rollupOptions: {
            external: ['react', 'react-dom', 'react/jsx-runtime'],
          },
          outDir: 'dist/lib',
          cssFileName: 'styles',
        },
      }
    : {}),
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    server: {
      deps: {
        inline: ['@lifo-sh/core', '@xterm/xterm'],
      },
    },
  },
})
