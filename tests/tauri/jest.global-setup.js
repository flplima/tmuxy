/**
 * Once before the Tauri suites: build the frontend and the app when missing,
 * then start Xvfb and tauri-driver.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { startXvfb } = require('./helpers/xvfb');
const { startTauriDriver } = require('./helpers/tauri-driver');
const { tmuxSocket } = require('../helpers/tmux-socket');
const { WORKSPACE_ROOT, tauriBinary } = require('../helpers/config');

module.exports = async function globalSetup() {
  console.warn('\n[tauri-e2e] Starting global setup...');

  console.warn(`[tauri-e2e] tmux socket: ${tmuxSocket()}`);

  // Tauri embeds the dist.
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

  // `tauri build`, not `cargo build`: a plain cargo binary is a dev build that
  // connects to devUrl (Vite, localhost:9001) instead of serving the embedded
  // dist.
  if (process.env.TAURI_BINARY && !fs.existsSync(tauriBinary())) {
    throw new Error(`TAURI_BINARY names ${tauriBinary()}, which does not exist`);
  }
  if (!fs.existsSync(tauriBinary())) {
    console.warn('[tauri-e2e] Building Tauri app (tauri build --debug --no-bundle)...');
    execSync('npx tauri build --debug --no-bundle', {
      cwd: path.join(WORKSPACE_ROOT, 'packages/tmuxy-tauri-app'),
      stdio: 'inherit',
      timeout: 600000,
    });
  } else {
    console.warn('[tauri-e2e] Tauri binary exists, skipping build');
  }

  console.warn('[tauri-e2e] Starting Xvfb...');
  startXvfb();
  console.warn('[tauri-e2e] Xvfb started on display :99');

  console.warn('[tauri-e2e] Starting tauri-driver...');
  await startTauriDriver();
  console.warn('[tauri-e2e] tauri-driver ready on port 4444');

  console.warn('[tauri-e2e] Global setup complete\n');
};
