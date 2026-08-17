/**
 * Manual trace demo (not a jest test): launch the real Tauri GUI under Xvfb via
 * WebDriver, interact with it (shell input, splits, new tabs, navigation), then
 * leave the NDJSON action-trace on disk for inspection. See docs/TELEMETRY.md.
 *
 * Run after `npx tauri build --debug --no-bundle` has produced target/debug/tmuxy:
 *   node tests/tauri/trace-demo.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const { startXvfb, stopXvfb } = require('./helpers/xvfb');
const { startTauriDriver, stopTauriDriver } = require('./helpers/tauri-driver');
const {
  createSession,
  waitForAppReady,
  waitForXState,
  typeKeys,
  pressKey,
  invokeCommand,
  waitForPaneCount,
  waitForRawWindowCount,
  getPaneCount,
  getRawWindowCount,
} = require('./helpers/wdio-client');
const { tmuxCmd } = require('../helpers/tmux-socket');

const TRACE = path.join(os.homedir(), '.local/state/tmuxy/trace.ndjson');

async function main() {
  // Start from a clean trace file so the demo's events are all we see.
  fs.mkdirSync(path.dirname(TRACE), { recursive: true });
  for (const f of [TRACE, `${TRACE}.1`]) {
    try {
      fs.rmSync(f);
    } catch {
      /* not there */
    }
  }

  startXvfb();
  await startTauriDriver();

  let driver = null;
  try {
    const s = await createSession();
    driver = s.driver;
    await waitForAppReady(driver);
    await waitForXState(driver);

    const traceOn = await invokeCommand(driver, 'trace_enabled');
    console.warn(`[demo] backend trace_enabled = ${traceOn}`);

    // 1) Real keystrokes → keyboardActor → XState SEND_TMUX_COMMAND → adapter send(keys)
    await typeKeys(driver, 'echo trace-demo-hello');
    await pressKey(driver, 'Enter');
    await driver.pause(500);

    // 2) Split panes — one through the REAL UI dispatch path (menu action →
    //    SEND_COMMAND → store → typed `Split` op), one via IPC.
    await driver.execute(() => window.tmuxyMenuAction?.('pane-split-right'));
    await waitForPaneCount(driver, 2);
    await invokeCommand(driver, 'split_pane_horizontal');
    await waitForPaneCount(driver, 3);

    // 3) Make two new tabs
    await invokeCommand(driver, 'new_window');
    await waitForRawWindowCount(driver, 2);
    await invokeCommand(driver, 'new_window');
    await waitForRawWindowCount(driver, 3);

    // 4) Navigate: switch windows and move the active pane around
    await invokeCommand(driver, 'run_tmux_command', { command: 'select-window -t :-' });
    await driver.pause(300);
    await invokeCommand(driver, 'run_tmux_command', { command: 'select-pane -t :.+' });
    await driver.pause(300);
    await invokeCommand(driver, 'run_tmux_command', { command: 'select-pane -t :.+' });
    await driver.pause(300);

    console.warn(
      `[demo] final: panes=${await getPaneCount(driver)} windows=${await getRawWindowCount(driver)}`,
    );

    // Let the client tracer flush its last batch and the backend settle before
    // we tear the app down (the tracer batches on a ~1s timer).
    await driver.pause(2000);
  } finally {
    if (driver) {
      try {
        await driver.deleteSession();
      } catch {
        /* already gone */
      }
    }
    stopTauriDriver();
    stopXvfb();
    try {
      execSync(`${tmuxCmd()} kill-session -t tmuxy`, { stdio: 'ignore' });
    } catch {
      /* session already gone */
    }
  }

  console.warn(`[demo] trace written to ${TRACE}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[demo] failed:', e);
    process.exit(1);
  });
