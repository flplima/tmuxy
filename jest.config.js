/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)test.js'],
  testTimeout: 240000,
  verbose: true,
  transformIgnorePatterns: [],
  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.js'],
  forceExit: true,
  detectOpenHandles: false,
  // Run test files sequentially — all tests share the same tmux server and
  // running in parallel causes cascading failures when one suite crashes tmux
  maxWorkers: 1,
};
