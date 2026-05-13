/**
 * Test Configuration
 */

const path = require('path');

// Ports and URLs
const CDP_PORT = 9222;
const TMUXY_PORT = parseInt(process.env.TMUXY_PORT || '9000', 10);
const TMUXY_URL = `http://localhost:${TMUXY_PORT}`;

// Paths
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');

// Timing
const DELAYS = {
  SHORT: 100,
  MEDIUM: 200,
  LONG: 500,
  EXTRA_LONG: 1000,
  SYNC: 1500, // For UI/tmux sync (full round trip: browser→HTTP→server→control mode→tmux→SSE→browser)
  PREFIX: 300, // Delay after tmux prefix key before next key
};

module.exports = {
  CDP_PORT,
  TMUXY_PORT,
  TMUXY_URL,
  WORKSPACE_ROOT,
  DELAYS,
};
