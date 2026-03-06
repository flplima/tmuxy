/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/?(*.)test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/helpers/'],
  testTimeout: 300000, // 5 minutes per test (Tauri app startup is slow)
  verbose: true,
  // Sequential — all tests share one Xvfb display and tauri-driver
  maxWorkers: 1,
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
};
