/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)test.js'],
  testPathIgnorePatterns: ['/node_modules/', 'tests/cli/', 'tests/tauri/'],
  // A real regression should report in a minute, not four. Individual flows
  // that genuinely need longer set their own timeout at the test.
  testTimeout: 120000,
  verbose: true,
  transformIgnorePatterns: [],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  // No forceExit: the shared browser is released in tests/jest.setup.js, so a
  // run that will not exit means a real leaked handle, which we want to see.
  detectOpenHandles: false,
  // Run test files sequentially — all tests share the same tmux server and
  // running in parallel causes cascading failures when one suite crashes tmux
  maxWorkers: 1,
};
