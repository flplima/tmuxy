/**
 * tauri-driver lifecycle management
 *
 * tauri-driver is a W3C WebDriver proxy that:
 * 1. Listens on a port (default 4444)
 * 2. Launches the Tauri app binary when a session is created
 * 3. Bridges WebDriver commands to WebKitWebDriver (the WebKitGTK webview driver)
 */

const { spawn } = require('child_process');

const DRIVER_PORT = 4444;

// Keyed by port, not a single global: the E2E suite owns 4444 for the whole
// jest run, and the perf harness may want its own driver on another port at
// the same time without either tearing down the other's.
const driverProcesses = new Map();

/**
 * Start tauri-driver on `port`, or return immediately if one is already
 * running there — including one this process did not start, so a job that
 * launched `tauri-driver` itself (as the CI desktop job does) is reused
 * rather than fought with.
 *
 * @param {number} [port] - defaults to {@link DRIVER_PORT}
 * @returns {Promise<{started: boolean, port: number}>} `started` is false when
 *   an existing driver was adopted, which is how the caller knows not to stop it.
 */
async function startTauriDriver(port = DRIVER_PORT) {
  if (driverProcesses.has(port)) return { started: false, port };

  if (await driverResponds(port)) return { started: false, port };

  const driverProcess = spawn('tauri-driver', ['--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  driverProcesses.set(port, driverProcess);

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
    driverProcesses.delete(port);
  });

  // Wait for tauri-driver to be ready
  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (await driverResponds(port)) return { started: true, port };
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`tauri-driver did not start on port ${port} within 10 seconds`);
}

/** Whether something is already answering WebDriver `/status` on `port`. */
async function driverResponds(port) {
  try {
    const res = await fetch(`http://localhost:${port}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Stop the tauri-driver this process started on `port`. A driver that was
 * adopted rather than started is left alone.
 *
 * @param {number} [port] - defaults to {@link DRIVER_PORT}
 */
function stopTauriDriver(port = DRIVER_PORT) {
  const driverProcess = driverProcesses.get(port);
  if (!driverProcess) return;
  try {
    driverProcess.kill('SIGTERM');
  } catch {
    // Already dead
  }
  driverProcesses.delete(port);
}

module.exports = { startTauriDriver, stopTauriDriver, driverResponds, DRIVER_PORT };
