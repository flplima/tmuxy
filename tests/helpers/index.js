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
const performance = require('./performance');
const TmuxTestSession = require('./TmuxTestSession');
const { GlitchDetector, OPERATION_THRESHOLDS } = require('./glitch-detector');
const consistency = require('./consistency');

// ==================== Known Limitations Registry ====================

/**
 * Registry of known feature limitations in the test suite.
 * Use noteKnownLimitation() to log these consistently.
 */
const KNOWN_LIMITATIONS = {
  OSC8_CLICKABLE_LINKS: {
    description: 'OSC 8 hyperlinks render as text only, not clickable',
    status: 'feature-enhancement',
    issue: null,
  },
  PANE_HEADER_DRAG_SWAP: {
    description: 'Dragging pane header may not swap panes',
    status: 'feature-incomplete',
    issue: null,
  },
  POPUP_SUPPORT: {
    description: 'Tmux popup requires control mode popup support (tmux PR #4361)',
    status: 'blocked-upstream',
    issue: 'https://github.com/tmux/tmux/pull/4361',
  },
  IME_INPUT: {
    description: 'IME composition requires platform-specific APIs unavailable in headless Chrome',
    status: 'testing-limitation',
    issue: null,
  },
  FLOAT_VIEW_TOGGLE_UI: {
    description: 'Float view toggle button not yet implemented in status bar',
    status: 'feature-incomplete',
    issue: null,
  },
  MOUSE_SELECTION_VARIES: {
    description: 'Text selection behavior varies by terminal implementation',
    status: 'acceptable-variation',
    issue: null,
  },
};

/**
 * Log a known limitation consistently.
 * @param {string} key - Key from KNOWN_LIMITATIONS
 * @param {string} context - Optional additional context
 */
function noteKnownLimitation(key, context = '') {
  const limitation = KNOWN_LIMITATIONS[key];
  if (limitation) {
    console.log(`ℹ️  Known limitation: ${limitation.description}`);
    if (context) console.log(`   Context: ${context}`);
    if (limitation.issue) console.log(`   Tracking: ${limitation.issue}`);
  } else {
    console.log(`ℹ️  Unknown limitation key: ${key}`);
  }
}

// ==================== Synthetic Event Helper ====================

/**
 * Send a state machine event directly to the app.
 *
 * WARNING: Use this ONLY when no UI exists for the action.
 * Prefer real UI interactions (clicks, keyboard) when possible.
 *
 * @param {Page} page - Playwright page
 * @param {object} event - State machine event object
 * @param {string} reason - Why synthetic event is necessary (for documentation)
 */
async function sendSyntheticEvent(page, event, reason) {
  if (process.env.DEBUG_TESTS) {
    console.log(`⚡ Synthetic event (${reason}):`, event.type);
  }

  await page.evaluate((evt) => {
    if (window.app) {
      window.app.send(evt);
    } else {
      throw new Error('window.app not available (only available in dev mode)');
    }
  }, event);
}

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

  // Performance
  ...performance,

  // Classes
  TmuxTestSession,

  // Limitations
  KNOWN_LIMITATIONS,
  noteKnownLimitation,

  // Synthetic events
  sendSyntheticEvent,

  // Glitch detection
  GlitchDetector,
  OPERATION_THRESHOLDS,

  // Consistency verification
  ...consistency,
};
