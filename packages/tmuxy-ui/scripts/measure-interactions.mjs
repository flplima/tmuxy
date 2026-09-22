#!/usr/bin/env node
/**
 * Interaction-latency harness — web target (CI gate).
 *
 * Measures the wall-clock cost of the handful of interactions a tmuxy user
 * performs constantly — typing, moving between panes, splitting, zooming,
 * switching tabs — from the real browser `keydown` to the first DOM change
 * that shows the result.
 *
 * Every interaction is driven through the real user path: a key goes to the
 * page, the keyboard actor resolves the tmux binding, the command crosses the
 * transport, tmux acts, and the state comes back. Nothing is short-circuited
 * with an adapter call, so a regression anywhere in that chain lands here.
 *
 * Runner-load noise makes an absolute millisecond budget unusable on CI, so
 * the report also carries each interaction's **ratio to the keystroke echo**
 * measured in the same run on the same machine. A keystroke is the cheapest
 * complete round trip tmuxy has; expressing everything else as a multiple of
 * it divides out the runner's speed. `compare-interactions.mjs` gates on
 * those ratios and only warns on the raw milliseconds.
 *
 * What is measured lives in `lib/perf-harness.mjs`, shared with the desktop
 * harness (`measure-interactions-tauri.mjs`) so a budget means the same thing
 * on both surfaces. This file is only the Playwright driver for it.
 *
 * Usage:
 *   node measure-interactions.mjs [--url URL] [--samples N] [--out FILE]
 *                                 [--label NAME] [--session NAME] [--cdp URL]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReport, runInteractions, waitForReady } from './lib/perf-harness.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const URL_BASE = opt('--url', 'http://localhost:9000');
const SAMPLES = Number(opt('--samples', '10'));
const OUT = opt('--out', null);
const LABEL = opt('--label', 'local');
const SESSION = opt('--session', null);
// Attach to an already-running Chrome over CDP instead of launching one. The
// dev environment has a browser on 9222 and deliberately does not install
// Playwright's own; CI is the reverse and launches.
const CDP = opt('--cdp', null);
const URL = SESSION ? `${URL_BASE}?session=${encodeURIComponent(SESSION)}` : URL_BASE;

/** The driver adapter contract from `lib/perf-harness.mjs`, over Playwright. */
function playwrightAdapter(page) {
  return {
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    install: (fn) => page.evaluate(fn),
    press: (key) => page.keyboard.press(key),
    type: (text) => page.keyboard.type(text),
    wait: (ms) => page.waitForTimeout(ms),
    clickActivePane: () =>
      page.locator('.pane-layout-item.pane-active [role="log"]').first().click({ timeout: 5000 }),
    // Playwright can hold the pending in-page promise across the keystroke, so
    // arming is just starting it and settling is awaiting it.
    arm: async (probe, arg, timeoutMs) => {
      const pending = page.evaluate(
        ([p, a, t]) => window.__perfArm(p, a, t),
        [probe, arg, timeoutMs],
      );
      return { settle: () => pending };
    },
  };
}

async function main() {
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
  // The first-run notice is modal and takes the keyboard; measure past it.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tmuxy-risk-notice-ack', '1');
    } catch {
      /* no storage, no notice */
    }
  });
  const page = await context.newPage();
  if (CDP) await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const adapter = playwrightAdapter(page);
  await waitForReady(adapter);
  const results = await runInteractions(adapter, { samples: SAMPLES });

  // A CDP browser belongs to the developer, not to us — close only the tab.
  if (CDP) await page.close();
  else await browser.close();

  const report = buildReport({
    results,
    label: LABEL,
    platform: `${process.platform}-${process.arch}`,
    target: 'web',
    url: URL,
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
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('measure-interactions failed:', e.stack || e.message);
  process.exit(1);
});
