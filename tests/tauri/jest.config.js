/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/?(*.)test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/helpers/'],
  testTimeout: 300000, // Tauri app startup is slow
  verbose: true,
  // One Xvfb display and one tauri-driver for every test.
  maxWorkers: 1,
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
};
