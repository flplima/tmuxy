#!/usr/bin/env node
/**
 * Interaction-latency harness, web target (the CI gate): from the browser's
 * `keydown` to the first DOM change that shows the result, for typing, moving
 * between panes, splitting, zooming and switching tabs, each through the real
 * key path. The suite is `lib/perf-harness.mjs`; this is its Playwright
 * driver.
 *
 * `--proxy-rtt MS` measures over a slow link (docs/PERFORMANCE.md, Axis B):
 * the browser reaches the server at `--url` through
 * `tests/helpers/latency-proxy.js`, which adds MS to every round trip. The
 * report's target is then `web-rtt<MS>`, so it is never judged against the
 * baseline of a run on the bare link.
 *
 * Usage:
 *   node measure-interactions.mjs [--url URL] [--samples N] [--out FILE]
 *                                 [--label NAME] [--session NAME] [--cdp URL]
 *                                 [--proxy-rtt MS]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReport, runInteractions, waitForReady } from './lib/perf-harness.mjs';
import latencyProxy from '../../../tests/helpers/latency-proxy.js';

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
// The dev environment has a browser on 9222 and does not install Playwright's
// own; CI launches one.
const CDP = opt('--cdp', null);
const PROXY_RTT = Number(opt('--proxy-rtt', '0'));

function playwrightAdapter(page) {
  return {
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    install: (fn) => page.evaluate(fn),
    press: (key) => page.keyboard.press(key),
    type: (text) => page.keyboard.type(text),
    wait: (ms) => page.waitForTimeout(ms),
    clickActivePane: () =>
      page.locator('.pane-layout-item.pane-active [role="log"]').first().click({ timeout: 5000 }),
    arm: async (probe, arg, timeoutMs, keys = 1) => {
      const pending = page.evaluate(
        ([p, a, t, k]) => window.__perfArm(p, a, t, k),
        [probe, arg, timeoutMs, keys],
      );
      return { settle: () => pending };
    },
  };
}

async function main() {
  const proxy =
    PROXY_RTT > 0
      ? await latencyProxy.startLatencyProxy({
          targetPort: Number(new globalThis.URL(URL_BASE).port || 80),
          rttMs: PROXY_RTT,
        })
      : null;
  const base = proxy ? proxy.url : URL_BASE;
  const URL = SESSION ? `${base}?session=${encodeURIComponent(SESSION)}` : base;

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

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const adapter = playwrightAdapter(page);
  await waitForReady(adapter);
  const results = await runInteractions(adapter, { samples: SAMPLES });

  // A CDP browser belongs to the developer, not to us — close only the tab.
  if (CDP) await page.close();
  else await browser.close();
  proxy?.stop();

  const report = buildReport({
    results,
    label: LABEL,
    platform: `${process.platform}-${process.arch}`,
    target: proxy ? `web-rtt${PROXY_RTT}` : 'web',
    url: URL,
    samplesRequested: SAMPLES,
    linkRttMs: proxy ? PROXY_RTT : null,
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
