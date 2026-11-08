#!/usr/bin/env node
/**
 * Soak harness: does a long session degrade? A leak fails no per-interaction
 * budget (each interaction stays fast while memory climbs), so this runs two
 * loads that leak in different places: output volume through one pane (the
 * control-mode parser, the delta protocol, the scrollback trim, the line
 * components) and split/kill churn (per-pane state in the app, the server and
 * tmux).
 *
 * It asserts a plateau, not a number: absolute heap and RSS depend on the
 * machine, the Chrome build and the runner's load, so each phase is sampled in
 * windows and the second half is compared to the first. Heap and node counts
 * come from CDP `Performance.getMetrics`, not `performance.memory`, which is
 * quantised to 5MB buckets. Server RSS is read from the OS.
 *
 * The load goes through `tmuxy pane send`, not the keyboard: Playwright's
 * `keyboard.type()` of a long command line drops characters (a mangled `yes`
 * once became an infinite loop).
 *
 * `--gate` is off until nightly runs have calibrated the thresholds.
 *
 * It splits, closes and types megabytes of `yes` into the session it is
 * served, and a server with no `TMUX_SOCKET` serves the default `tmuxy` socket
 * (someone's working session), so give the server under test its own socket:
 *
 *   TMUX_SOCKET=tmuxy-soak ./target/release/tmuxy-server --port 9131 --dev
 *
 * Usage:
 *   node measure-soak.mjs [--url URL] [--session NAME] [--cdp URL]
 *                         [--output-mb N] [--cycles N] [--windows N]
 *                         [--out FILE] [--label NAME] [--server-pid PID]
 *                         [--socket NAME] [--cli PATH] [--gate]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { waitForReady } from './lib/perf-harness.mjs';
import { discoverServerPid, plateau, printSoakTable, sample, settle } from './lib/soak-metrics.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(name);

const URL_BASE = opt('--url', 'http://localhost:9000');
const SESSION = opt('--session', null);
const CDP = opt('--cdp', null);
/** Megabytes of output to stream through a pane, total. */
const OUTPUT_MB = Number(opt('--output-mb', '20'));
const CYCLES = Number(opt('--cycles', '200'));
/** Sample windows per phase: even, at least 4. */
const WINDOWS = Number(opt('--windows', '8'));
const OUT = opt('--out', null);
const LABEL = opt('--label', 'local');
const SERVER_PID = opt('--server-pid', null);
const GATE = flag('--gate');
const SOCKET = opt('--socket', process.env.TMUX_SOCKET ?? null);
const CLI = opt('--cli', new URL('../../tmuxy-cli/bin/tmuxy-cli', import.meta.url).pathname);

// Not named `URL`: that shadows the global this file uses to resolve the CLI
// path, and the shadow is hoisted, so the resolution hits a TDZ error.
const TARGET_URL = SESSION ? `${URL_BASE}?session=${encodeURIComponent(SESSION)}` : URL_BASE;

// `pane send` routes the keys through `tmux run-shell`, the control-mode-safe
// way in (docs/TMUX.md); `Enter` is send-keys' name for the key.
function runInPane(line) {
  execFileSync(CLI, ['pane', 'send', line, 'Enter'], {
    encoding: 'utf-8',
    env: { ...process.env, ...(SOCKET ? { TMUX_SOCKET: SOCKET } : {}) },
    timeout: 20000,
  });
}

// `yes | head -c`: real bytes through the parser, not a tight redraw loop.
async function phaseOutput(page, cdp, serverPid, { mb, windows }) {
  const samples = [];
  const chunkMB = Math.max(1, Math.round(mb / windows));
  for (let w = 0; w < windows; w++) {
    // A sentinel, not a prompt match: with megabytes of `yes` in the
    // scrollback the last visible line is whatever the trim left behind.
    const done = `SOAK-OUTPUT-DONE-${w}`;
    runInPane(`yes soakline | head -c ${chunkMB}m; echo ${done}`);
    await page.waitForFunction(
      (marker) =>
        [...document.querySelectorAll('[role="log"]')].some((l) =>
          (l.textContent || '').includes(marker),
        ),
      done,
      { timeout: 180000, polling: 500 },
    );
    await settle(cdp, page);
    samples.push({ window: w, ...(await sample(cdp, serverPid)) });
  }
  return samples;
}

function countPanes(page) {
  return page.evaluate(
    () =>
      new Set(
        [...document.querySelectorAll('[data-pane-id]')].map((e) => e.getAttribute('data-pane-id')),
      ).size,
  );
}

async function waitForPaneCount(page, predicate, reference) {
  await page
    .waitForFunction(
      ([ref, op]) => {
        const n = new Set(
          [...document.querySelectorAll('[data-pane-id]')].map((e) =>
            e.getAttribute('data-pane-id'),
          ),
        ).size;
        return op === 'gt' ? n > ref : n <= ref;
      },
      [reference, predicate],
      { timeout: 20000, polling: 100 },
    )
    // A cycle that does not complete is not the measurement failing — the next
    // one re-reads the count, so a missed split cannot desynchronise the loop.
    .catch(() => {});
}

function splitPane() {
  execFileSync(CLI, ['pane', 'split', '-v'], {
    encoding: 'utf-8',
    env: { ...process.env, ...(SOCKET ? { TMUX_SOCKET: SOCKET } : {}) },
    timeout: 20000,
  });
}

// Through the CLI, never a raw `tmux split-window`: an external mutation
// crashes tmux while control mode is attached (docs/TMUX.md).
async function phaseChurn(page, cdp, serverPid, { cycles, windows }) {
  const samples = [];
  const perWindow = Math.max(1, Math.round(cycles / windows));

  for (let w = 0; w < windows; w++) {
    for (let i = 0; i < perWindow; i++) {
      const before = await countPanes(page);
      splitPane();
      await waitForPaneCount(page, 'gt', before);
      runInPane('exit');
      await waitForPaneCount(page, 'lte', before);
    }
    await settle(cdp, page);
    samples.push({ window: w, cyclesDone: (w + 1) * perWindow, ...(await sample(cdp, serverPid)) });
  }
  return samples;
}

async function main() {
  if (WINDOWS % 2 !== 0 || WINDOWS < 4) {
    console.error(`--windows must be an even number of at least 4 (got ${WINDOWS})`);
    process.exit(2);
  }

  const serverPid = discoverServerPid(SERVER_PID);
  const browser = CDP
    ? await chromium.connectOverCDP(CDP)
    : await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
  const context = CDP
    ? (browser.contexts()[0] ?? (await browser.newContext()))
    : await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  if (CDP) await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');

  await waitForReady({
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    wait: (ms) => page.waitForTimeout(ms),
  });
  await page.locator('.pane-layout-item.pane-active [role="log"]').first().click({ timeout: 5000 });

  await settle(cdp, page);
  const baseline = await sample(cdp, serverPid);

  const started = Date.now();
  const output = await phaseOutput(page, cdp, serverPid, { mb: OUTPUT_MB, windows: WINDOWS });
  const churn = await phaseChurn(page, cdp, serverPid, { cycles: CYCLES, windows: WINDOWS });
  const durationMs = Date.now() - started;

  await settle(cdp, page);
  const final = await sample(cdp, serverPid);

  if (CDP) await page.close();
  else await browser.close();

  const report = {
    label: LABEL,
    platform: `${process.platform}-${process.arch}`,
    url: TARGET_URL,
    generatedAt: new Date().toISOString(),
    durationMs,
    load: { outputMB: OUTPUT_MB, cycles: CYCLES, windows: WINDOWS },
    serverPid,
    baseline,
    final,
    phases: {
      output: { samples: output, plateau: plateau(output) },
      churn: { samples: churn, plateau: plateau(churn) },
    },
  };

  const json = JSON.stringify(report, null, 2);
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${json}\n`);
    console.log(`wrote soak report → ${OUT}`);
  }

  const grew = printSoakTable(report.phases);

  if (grew.length === 0) {
    console.log('\nEvery measure plateaued.');
    return;
  }

  const summary = `did not plateau: ${grew.join(', ')}`;
  if (GATE) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  console.warn(`\nwarning: ${summary} (not gating — pass --gate to fail on this)`);
}

main().catch((e) => {
  console.error('measure-soak failed:', e.stack || e.message);
  process.exit(1);
});
