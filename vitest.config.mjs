import { defineConfig } from 'vitest/config';

// The repo's unit tests, in one run: the UI package under its own config
// (jsdom, its setup file), and the Node scripts tested beside the code they
// test — the CI rules under bin/ci, the demo's build scripts.
export default defineConfig({
  test: {
    projects: [
      'packages/tmuxy-ui',
      {
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['bin/**/*.test.mjs', 'packages/tmuxy-demo/scripts/**/*.test.mjs'],
        },
      },
    ],
  },
});
