#!/usr/bin/env node
/**
 * Interaction-latency harness, desktop (Tauri) target: the web harness's suite
 * (`lib/perf-harness.mjs`) over another driver. The desktop app has no CDP
 * endpoint, so it is driven through `tauri-driver` → WebKitWebDriver over
 * WebdriverIO. Reports land under a `tauri` target, held to their own
 * baseline: the desktop app reaches the core over Tauri IPC instead of
 * `POST /commands` + SSE.
 *
 * The app must already be built (`npx tauri build --no-bundle`, release, in
 * `packages/tmuxy-tauri-app`). tauri-driver is started here if nothing is
 * already answering on its port, and is left alone if something is.
 *
 * Usage:
 *   node measure-interactions-tauri.mjs [--binary PATH] [--samples N]
 *                                       [--out FILE] [--label NAME]
 *                                       [--driver-port N] [--session NAME]
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { remote } from 'webdriverio';
import { buildReport, runInteractions, waitForReady } from './lib/perf-harness.mjs';
import { WD_KEYS, toChord } from './lib/wd-keys.mjs';
import { assertThrowawaySocket } from './lib/throwaway.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(HERE, '../../..');

const { startTauriDriver, stopTauriDriver, DRIVER_PORT } = require(
  resolve(WORKSPACE_ROOT, 'tests/tauri/helpers/tauri-driver.js'),
);
const { startXvfb, stopXvfb } = require(resolve(WORKSPACE_ROOT, 'tests/tauri/helpers/xvfb.js'));
const { tmuxCmd, tmuxEnv } = require(resolve(WORKSPACE_ROOT, 'tests/helpers/tmux-socket.js'));

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const SAMPLES = Number(opt('--samples', '10'));
const OUT = opt('--out', null);
const LABEL = opt('--label', 'local');
const DRIVER = Number(opt('--driver-port', String(DRIVER_PORT)));
// Release by default: a debug build's own slowness would swamp the
// differences between interactions.
const BINARY = opt('--binary', resolve(WORKSPACE_ROOT, 'target/release/tmuxy'));
const SESSION = opt('--session', 'tmuxy-perf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wdioAdapter(driver) {
  return {
    evaluate: (fn, arg) => driver.execute(fn, arg),
    install: (fn) => driver.execute(fn),
    press: (key) => driver.keys(toChord(key)),
    type: async (text) => {
      for (const ch of text) {
        await driver.keys(ch === '\n' ? [WD_KEYS.Enter] : [ch]);
        await sleep(30);
      }
    },
    wait: sleep,
    clickActivePane: async () => {
      const el = await driver.$('.pane-layout-item.pane-active [role="log"]');
      await el.waitForExist({ timeout: 10000 });
      await el.click();
    },
    // WebKitWebDriver's `execute` is synchronous and cannot hold a pending
    // in-page promise across the keystroke, so the armer parks its answer on
    // `window` and settling polls for it.
    arm: async (probe, arg, timeoutMs, keys = 1) => {
      await driver.execute(
        (p, a, t, k) => {
          window.__perfArmStart(p, a, t, k);
        },
        probe,
        arg,
        timeoutMs,
        keys,
      );
      return {
        settle: async () => {
          const deadline = Date.now() + timeoutMs + 2000;
          while (Date.now() < deadline) {
            const value = await driver.execute(() => window.__perfResult);
            if (typeof value === 'number') return value;
            await sleep(25);
          }
          return -1;
        },
      };
    },
  };
}

/** `xdpyinfo`, the same probe `startXvfb` waits on. */
function displayIsLive() {
  const display = process.env.DISPLAY;
  if (!display) return false;
  try {
    execSync(`xdpyinfo -display ${display}`, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh `session` on the socket `TMUX_SOCKET` names, in the suite's
 * environment, which the app gets too (`driverEnv`). Pre-created, because the
 * app's own session creation can fail when the user's tmuxy config carries
 * settings (`window-size manual`) that crash tmux on a fresh start with no
 * attached client.
 */
function prepareSession(session) {
  const tmux = (args) => execSync(`${tmuxCmd()} ${args}`, { stdio: 'ignore', env: tmuxEnv() });
  try {
    tmux(`kill-session -t ${session}`);
  } catch {
    // Not running yet.
  }
  tmux(`new-session -d -s ${session}`);
}

async function main() {
  if (!existsSync(BINARY)) {
    console.error(
      `no Tauri binary at ${BINARY}\n` +
        'build it first: (cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)',
    );
    process.exit(2);
  }

  // A socket of its own, so a perf run never disturbs the developer's session.
  const socket = process.env.TMUX_SOCKET || 'tmuxy-perf';
  assertThrowawaySocket(socket);
  process.env.TMUX_SOCKET = socket;
  process.env.TMUXY_SESSION = SESSION;
  prepareSession(SESSION);

  // WebKitGTK needs a live X display. The Tauri E2E suite kills its Xvfb in
  // globalTeardown, leaving `DISPLAY` pointing at a dead server, and the app
  // then panics out of `tao` with "Failed to initialize GTK".
  const needsXvfb = process.platform === 'linux' && !displayIsLive();
  if (needsXvfb) startXvfb();

  // Adopts a driver someone else started (the CI desktop job launches its own).
  const { started } = await startTauriDriver(DRIVER);

  let driver;
  try {
    driver = await remote({
      hostname: 'localhost',
      port: DRIVER,
      capabilities: {
        // No `env`: tauri-driver does not forward `tauri:options.env`; the
        // binary inherits the driver's environment (`driverEnv`), which is why
        // `DISPLAY` and `TMUX_SOCKET` are set on this process before
        // startTauriDriver().
        'tauri:options': { application: BINARY },
      },
      logLevel: 'warn',
      connectionRetryTimeout: 30000,
      connectionRetryCount: 3,
    });

    const log = await driver.$('[role="log"]');
    await log.waitForExist({ timeout: 30000 });

    const adapter = wdioAdapter(driver);
    await waitForReady(adapter);
    const results = await runInteractions(adapter, { samples: SAMPLES });

    const report = buildReport({
      results,
      label: LABEL,
      platform: `${process.platform}-${process.arch}`,
      target: 'tauri',
      url: BINARY,
      samplesRequested: SAMPLES,
    });

    const json = JSON.stringify(report, null, 2);
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${json}\n`);
      console.log(`wrote interaction report → ${OUT}`);
    }
    console.log(json);

    const unusable = report.interactions.filter((i) => i.samples === 0);
    if (unusable.length > 0) {
      console.error(`no usable samples for: ${unusable.map((i) => i.name).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    if (driver) await driver.deleteSession().catch(() => {});
    if (started) stopTauriDriver(DRIVER);
    if (needsXvfb) stopXvfb();
  }
}

main().catch((e) => {
  console.error('measure-interactions-tauri failed:', e.stack || e.message);
  process.exit(1);
});
