/**
 * Test Configuration
 */

const path = require('path');

// Ports and URLs
const CDP_PORT = 9222;
const TMUXY_PORT = 9000;
const TMUXY_URL = `http://localhost:${TMUXY_PORT}`;

// Paths
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');

// Timing
const DELAYS = {
  SHORT: 100,
  MEDIUM: 200,
  LONG: 300,
  EXTRA_LONG: 1000,
  SYNC: 1000, // For UI/tmux sync
  PREFIX: 200, // Delay after tmux prefix key before next key
};

module.exports = {
  CDP_PORT,
  TMUXY_PORT,
  TMUXY_URL,
  WORKSPACE_ROOT,
  DELAYS,
};
