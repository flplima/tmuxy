/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/?(*.)test.js'],
  // Longer than the deadline of the waits a test makes (`helpers/wait.js`),
  // so one that gives up says what it was waiting for.
  testTimeout: 60000,
  // The run's own socket, and the seal on every child a test starts: the
  // suite must not be able to reach a tmux server anyone works in.
  globalSetup: '<rootDir>/setup/global-setup.js',
  globalTeardown: '<rootDir>/setup/global-teardown.js',
  setupFilesAfterEnv: ['<rootDir>/setup/seal-children.js'],
  verbose: true,
};
