/**
 * Jest Global Teardown for Tauri E2E Tests
 *
 * Runs once after all test suites:
 * 1. Stop tauri-driver
 * 2. Stop Xvfb
 * 3. Kill any leftover tauri_test_* tmux sessions
 */

const { execSync } = require('child_process');
const { stopTauriDriver } = require('./helpers/tauri-driver');
const { stopXvfb } = require('./helpers/xvfb');

module.exports = async function globalTeardown() {
  console.warn('\n[tauri-e2e] Starting global teardown...');

  // Stop tauri-driver
  stopTauriDriver();
  console.warn('[tauri-e2e] tauri-driver stopped');

  // Stop Xvfb
  stopXvfb();
  console.warn('[tauri-e2e] Xvfb stopped');

  // Kill leftover test tmux sessions
  try {
    const sessions = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
    }).trim();
    for (const session of sessions.split('\n')) {
      if (session.startsWith('tauri_test_')) {
        try {
          execSync(`tmux kill-session -t ${session}`, { stdio: 'ignore' });
        } catch {
          // Session already gone
        }
      }
    }
  } catch {
    // No tmux server or no sessions
  }

  console.warn('[tauri-e2e] Global teardown complete\n');
};
