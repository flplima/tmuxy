/**
 * tauri-driver lifecycle management
 *
 * tauri-driver is a W3C WebDriver proxy that:
 * 1. Listens on a port (default 4444)
 * 2. Launches the Tauri app binary when a session is created
 * 3. Bridges WebDriver commands to WebKitWebDriver (the WebKitGTK webview driver)
 */

const { spawn, execSync } = require('child_process');

const DRIVER_PORT = 4444;
let driverProcess = null;

/**
 * Start tauri-driver on the configured port
 */
async function startTauriDriver() {
  if (driverProcess) return;

  driverProcess = spawn('tauri-driver', ['--port', String(DRIVER_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  // Log driver output for debugging
  driverProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.warn(`[tauri-driver] ${msg}`);
  });
  driverProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[tauri-driver] ${msg}`);
  });

  driverProcess.on('exit', (code) => {
    console.warn(`[tauri-driver] exited with code ${code}`);
    driverProcess = null;
  });

  // Wait for tauri-driver to be ready
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const res = await fetch(`http://localhost:${DRIVER_PORT}/status`);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }

  throw new Error(`tauri-driver did not start on port ${DRIVER_PORT} within 10 seconds`);
}

/**
 * Stop tauri-driver
 */
function stopTauriDriver() {
  if (driverProcess) {
    try {
      driverProcess.kill('SIGTERM');
    } catch {
      // Already dead
    }
    driverProcess = null;
  }
}

module.exports = { startTauriDriver, stopTauriDriver, DRIVER_PORT };
