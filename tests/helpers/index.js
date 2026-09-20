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
const cellGrid = require('./cell-grid');

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

  // Cell-grid geometry (rendered cells vs tmux cells)
  ...cellGrid,

  // Mouse capture helpers
  ...mouseCapture,
};

// Suites that drive a browser of their own (a second engine, a touch context)
// and the pointer-selection geometry they share. Appended so the two new
// modules are reachable through this index like every other helper; the
// suites themselves require them directly, so a rewrite of this file cannot
// break them.
Object.assign(module.exports, require('./own-browser'), require('./selection-drag'));
