/**
 * tauri-driver: a W3C WebDriver proxy that launches the app binary when a
 * session is created and bridges the commands to WebKitWebDriver (the
 * WebKitGTK webview's driver).
 */

const { spawn } = require('child_process');
const { tmuxEnv } = require('../../helpers/tmux-socket');

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
    env: driverEnv(),
  });
  driverProcesses.set(port, driverProcess);

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

  const start = Date.now();
  while (Date.now() - start < 10000) {
    if (await driverResponds(port)) return { started: true, port };
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`tauri-driver did not start on port ${port} within 10 seconds`);
}

/**
 * The driver hands its environment to the app it launches, so this is the
 * app's: the suite's tmux socket, `$HOME` and tmuxy dirs (`tmuxEnv`), never the
 * developer's. At start the app mirrors this branch's config, themes and
 * scripts into its config and data dirs, which would otherwise be the
 * installed app's. `DISPLAY` rides along from the process (Xvfb sets it).
 */
function driverEnv() {
  return tmuxEnv();
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

module.exports = { startTauriDriver, stopTauriDriver, driverEnv, DRIVER_PORT };
