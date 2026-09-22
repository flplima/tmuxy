#!/usr/bin/env node
/**
 * Interaction-latency harness — desktop (Tauri) target.
 *
 * The same interactions, the same probes and the same report shape as the web
 * harness (`measure-interactions.mjs`); both import the suite from
 * `lib/perf-harness.mjs`. Only the driver differs: the desktop app has no CDP
 * endpoint, so it is driven through `tauri-driver` → WebKitWebDriver over
 * WebdriverIO, against the binary a user actually launches.
 *
 * Why this exists: the desktop app reaches the same Rust core over Tauri IPC
 * instead of `POST /commands` + SSE. That is a different transport with a
 * different cost, and until this harness there was no number for it at all —
 * only a README claim that it is faster. Reports land under a `tauri` target
 * so `compare-interactions.mjs` holds them to their own baseline; comparing
 * desktop milliseconds against web ones would measure the transport swap and
 * the platform at once.
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

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(HERE, '../../..');

// One implementation of the driver lifecycle, shared with the E2E suite.
const { startTauriDriver, stopTauriDriver, DRIVER_PORT } = require(
  resolve(WORKSPACE_ROOT, 'tests/tauri/helpers/tauri-driver.js'),
);
const { startXvfb, stopXvfb } = require(resolve(WORKSPACE_ROOT, 'tests/tauri/helpers/xvfb.js'));

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const SAMPLES = Number(opt('--samples', '10'));
const OUT = opt('--out', null);
const LABEL = opt('--label', 'local');
const DRIVER = Number(opt('--driver-port', String(DRIVER_PORT)));
// Release by default: this harness exists to describe the binary a user
// launches, and a debug build's own slowness would swamp the differences
// between interactions it is here to see.
const BINARY = opt('--binary', resolve(WORKSPACE_ROOT, 'target/release/tmuxy'));
const SESSION = opt('--session', 'tmuxy-perf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The driver adapter contract from `lib/perf-harness.mjs`, over WebdriverIO. */
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
    // `window` and settling polls for it. The timing itself still happens
    // in-page, so none of this polling cost lands in the number.
    arm: async (probe, arg, timeoutMs) => {
      await driver.execute(
        (p, a, t) => {
          window.__perfArmStart(p, a, t);
        },
        probe,
        arg,
        timeoutMs,
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

/**
 * Give the app a tmux session of its own.
 *
 * The app's built-in session creation can fail when the user's tmuxy config
 * carries settings (`window-size manual`) that crash tmux on a fresh start
 * with no attached client, so it is pre-created here — same reason the E2E
 * suite does it.
 */
function prepareSession(socket, session) {
  const tmux = `tmux -L ${socket}`;
  try {
    execSync(`${tmux} kill-session -t ${session}`, { stdio: 'ignore' });
  } catch {
    // Not running yet.
  }
  execSync(`${tmux} new-session -d -s ${session}`, { stdio: 'ignore' });
}

async function main() {
  if (!existsSync(BINARY)) {
    console.error(
      `no Tauri binary at ${BINARY}\n` +
        'build it first: (cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)',
    );
    process.exit(2);
  }

  // A socket of its own, so a perf run can never disturb the session the
  // developer is working in — the same rule the E2E suite follows.
  const socket = process.env.TMUX_SOCKET || 'tmuxy-perf';
  process.env.TMUX_SOCKET = socket;
  process.env.TMUXY_SESSION = SESSION;
  prepareSession(socket, SESSION);

  // WebKitGTK needs an X display; macOS does not.
  const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
  if (needsXvfb) startXvfb();

  // Adopts a driver someone else started (the CI desktop job launches its own).
  const { started } = await startTauriDriver(DRIVER);

  let driver;
  try {
    driver = await remote({
      hostname: 'localhost',
      port: DRIVER,
      capabilities: {
        'tauri:options': {
          application: BINARY,
          env: { DISPLAY: process.env.DISPLAY || ':99', TMUX_SOCKET: socket },
        },
      },
      logLevel: 'warn',
      connectionRetryTimeout: 30000,
      connectionRetryCount: 3,
    });

    // The first-run notice is modal and takes the keyboard. There is no init
    // script for a WebKit webview, so it is dismissed once the page exists.
    const log = await driver.$('[role="log"]');
    await log.waitForExist({ timeout: 30000 });
    await driver.execute(() => {
      window.localStorage.setItem('tmuxy-risk-notice-ack', '1');
      if (window.app?.getSnapshot().context.riskNoticeOpen) {
        window.app.send({ type: 'DISMISS_RISK_NOTICE', remember: true });
      }
    });

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
