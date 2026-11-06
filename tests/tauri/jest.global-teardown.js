/** Once after the Tauri suites: stop tauri-driver and Xvfb. */

const { stopTauriDriver } = require('./helpers/tauri-driver');
const { stopXvfb } = require('./helpers/xvfb');

module.exports = async function globalTeardown() {
  console.warn('\n[tauri-e2e] Starting global teardown...');

  stopTauriDriver();
  console.warn('[tauri-e2e] tauri-driver stopped');

  stopXvfb();
  console.warn('[tauri-e2e] Xvfb stopped');

  console.warn('[tauri-e2e] Global teardown complete\n');
};
