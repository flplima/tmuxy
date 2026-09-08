/**
 * Jest Global Setup for Tauri E2E Tests
 *
 * Runs once before all test suites:
 * 1. Build the frontend (tmuxy-ui dist)
 * 2. Build the Tauri binary (debug mode for speed)
 * 3. Start Xvfb virtual display
 * 4. Start tauri-driver WebDriver proxy
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startXvfb } = require('./helpers/xvfb');
const { startTauriDriver } = require('./helpers/tauri-driver');
const { DEFAULT_SOCKET, tmuxSocket } = require('../helpers/tmux-socket');

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TAURI_BINARY = path.join(WORKSPACE_ROOT, 'target/debug/tmuxy');

module.exports = async function globalSetup() {
  console.warn('\n[tauri-e2e] Starting global setup...');

  // Pin the tmux socket for the app AND for the assertions about it.
  //
  // The app under test resolves its own socket from TMUX_SOCKET, and these
  // tests read tmux through the shared helpers, which resolve it the same way
  // — so the two agree only if it is set once, here, before anything starts.
  // Left unset they diverge the moment the helpers' default differs from the
  // app's own (`tmuxy`), and the suite then asserts against a tmux server the
  // app never touched: panes "missing", windows "not created".
  //
  // Must happen before startTauriDriver(): the driver inherits this
  // environment and hands it to the app binary it launches. Jest forks its
  // workers after globalSetup, so the test files inherit it too.
  process.env.TMUX_SOCKET = process.env.TMUX_SOCKET || DEFAULT_SOCKET;
  console.warn(`[tauri-e2e] tmux socket: ${tmuxSocket()}`);

  // Step 1: Build frontend dist (needed by Tauri to embed)
  const distDir = path.join(WORKSPACE_ROOT, 'packages/tmuxy-ui/dist');
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.warn('[tauri-e2e] Building frontend...');
    execSync('npm run build -w tmuxy-ui', {
      cwd: WORKSPACE_ROOT,
      stdio: 'inherit',
      timeout: 120000,
    });
  } else {
    console.warn('[tauri-e2e] Frontend dist exists, skipping build');
  }

  // Step 2: Build Tauri binary with `tauri build --debug`
  // Must use `tauri build` (not bare `cargo build`) so the frontend dist is
  // embedded into the binary. Plain `cargo build` produces a dev binary that
  // tries to connect to devUrl (localhost:1420) instead of serving the embedded
  // assets.
  if (!fs.existsSync(TAURI_BINARY)) {
    console.warn('[tauri-e2e] Building Tauri app (tauri build --debug --no-bundle)...');
    execSync('npx tauri build --debug --no-bundle', {
      cwd: path.join(WORKSPACE_ROOT, 'packages/tmuxy-tauri-app'),
      stdio: 'inherit',
      timeout: 600000, // 10 minutes
    });
  } else {
    console.warn('[tauri-e2e] Tauri binary exists, skipping build');
  }

  // Step 3: Start Xvfb
  console.warn('[tauri-e2e] Starting Xvfb...');
  startXvfb();
  console.warn('[tauri-e2e] Xvfb started on display :99');

  // Step 4: Start tauri-driver
  console.warn('[tauri-e2e] Starting tauri-driver...');
  await startTauriDriver();
  console.warn('[tauri-e2e] tauri-driver ready on port 4444');

  console.warn('[tauri-e2e] Global setup complete\n');
};
