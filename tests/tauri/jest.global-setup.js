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

const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const TAURI_BINARY = path.join(WORKSPACE_ROOT, 'target/debug/tauri-app');

module.exports = async function globalSetup() {
  console.warn('\n[tauri-e2e] Starting global setup...');

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
      cwd: path.join(WORKSPACE_ROOT, 'packages/tauri-app'),
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
