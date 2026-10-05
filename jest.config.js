const path = require('path');
const { stateDir } = require('./tests/helpers/tmux-socket');

// Where the server under test writes its action trace, and where each test's
// start/end markers go (tests/helpers/trace-environment.js). CI sets it to a
// file it uploads; locally it sits in the run's scratch state dir.
if (!process.env.TMUXY_E2E_TRACE) {
  process.env.TMUXY_E2E_TRACE = path.join(stateDir(), 'trace.ndjson');
  // One run, one trace: a previous run's events would read as this one's.
  // (CI names its own file and starts the server before Jest, so it is left alone.)
  require('fs').rmSync(process.env.TMUXY_E2E_TRACE, { force: true });
}

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: '<rootDir>/tests/helpers/trace-environment.js',
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
