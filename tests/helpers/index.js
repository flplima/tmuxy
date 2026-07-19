/**
 * Test Helpers Index
 *
 * Re-exports all helper modules for easy importing
 */

const config = require('./config');
const browser = require('./browser');
const ui = require('./ui');
const testSetup = require('./test-setup');
const performance = require('./performance');
const TmuxTestSession = require('./TmuxTestSession');
const { GlitchDetector, OPERATION_THRESHOLDS } = require('./glitch-detector');
const consistency = require('./consistency');
const cli = require('./cli');
const { assertContentMatch, assertAltScreenMatch } = require('./content-match');
const { assertLayoutInvariants } = require('./layout');
const copyMode = require('./copy-mode');
const mouseCapture = require('./mouse-capture');

// Re-export everything
module.exports = {
  // Config
  ...config,

  // Browser
  ...browser,

  // UI
  ...ui,

  // Test Setup
  ...testSetup,

  // Performance
  ...performance,

  // Classes
  TmuxTestSession,

  // Glitch detection
  GlitchDetector,
  OPERATION_THRESHOLDS,

  // Consistency verification
  ...consistency,

  // CLI helpers
  ...cli,

  // Content-match assertions
  assertContentMatch,
  assertAltScreenMatch,

  // Layout invariant assertions
  assertLayoutInvariants,

  // Copy mode helpers
  ...copyMode,

  // Mouse capture helpers
  ...mouseCapture,
};
