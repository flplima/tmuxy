/**
 * Test Helpers Index
 *
 * Re-exports all helper modules for easy importing
 */

const config = require('./config');
const browser = require('./browser');
const tmux = require('./tmux');
const ui = require('./ui');
const assertions = require('./assertions');
const testSetup = require('./test-setup');
const TmuxTestSession = require('./TmuxTestSession');

// Re-export everything
module.exports = {
  // Config
  ...config,

  // Browser
  ...browser,

  // Tmux
  ...tmux,

  // UI
  ...ui,

  // Assertions
  ...assertions,

  // Test Setup
  ...testSetup,

  // Classes
  TmuxTestSession,
};
