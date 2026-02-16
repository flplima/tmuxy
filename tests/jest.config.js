/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  testTimeout: 60000,
  verbose: true,
  // Don't transform ES modules
  transformIgnorePatterns: [],
  // Setup files
  setupFilesAfterEnv: ['./jest.setup.js'],
  // Force exit after tests complete
  forceExit: true,
  // Detect open handles for debugging
  detectOpenHandles: false,
  // Run test files sequentially — all tests share the same tmux server and
  // running in parallel causes cascading failures when one suite crashes tmux
  maxWorkers: 1,
};
