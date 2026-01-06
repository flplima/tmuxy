/**
 * Test Configuration
 */

const path = require('path');

// Ports and URLs
const CDP_PORT = 9222;
const TMUXY_PORT = 3853;
const TMUXY_URL = `http://localhost:${TMUXY_PORT}`;

// Paths
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');

// Timing
const DELAYS = {
  SHORT: 100,
  MEDIUM: 300,
  LONG: 500,
  EXTRA_LONG: 1000,
  SYNC: 2000, // For UI/tmux sync
};

module.exports = {
  CDP_PORT,
  TMUXY_PORT,
  TMUXY_URL,
  WORKSPACE_ROOT,
  DELAYS,
};
