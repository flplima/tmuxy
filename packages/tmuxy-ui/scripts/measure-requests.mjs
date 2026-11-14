#!/usr/bin/env node
/**
 * What a user action costs on the wire: how many requests it makes and how
 * many bytes come back, counted by the page itself (Resource Timing and the
 * body of each `POST /commands`). Counts and bytes do not depend on how fast
 * the machine or the link is, so the budgets below hold on loopback, where
 * the cost they bound cannot be felt (docs/TESTS.md, "The Loopback Trap").
 *
 * Usage:
 *   node measure-requests.mjs [--url URL] [--cdp URL] [--out FILE]
 *
 * Exits 1 when a step goes over its budget.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const URL_BASE = opt('--url', 'http://localhost:9000');
const CDP = opt('--cdp', null);
const OUT = opt('--out', null);
// A session of this run's own: what a step counts depends on the panes and
// tabs it starts from.
const SESSION = `requests-${Date.now().toString(36)}`;
const PAGE_URL = `${URL_BASE}?session=${SESSION}`;

/** Long enough for an action's last request to be answered and counted. */
const QUIET_MS = 1500;
const ACTIVE_LOG = '.pane-layout-item.pane-active [role="log"]';

/**
 * The most a step may cost. Ceilings with headroom, not targets: each one is
 * a multiple below what the step cost before it was bounded.
 */
const BUDGETS = {
  'cold load': { bundleBytes: 600_000 },
  reload: { bytes: 60_000 },
  '5 keys, one client': { commands: 5 },
  '5 keys beside a smaller client': { commands: 5, set_client_size: 0 },
  'window edge dragged for a second': { set_client_size: 2 },
  '5 wheel notches over a mouse app': { commands: 6 },
  'first scroll-up of a 20,000-line history': { bytes: 200_000 },
};

/** Runs in every document before the app: keeps what it asks the server for. */
function recordRequests() {
  window.__requests = { resources: [], commands: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__requests.resources.push({ name: entry.name, bytes: entry.transferSize });
    }
  }).observe({ type: 'resource', buffered: true });
  const send = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url, location.href).pathname === '/commands' && typeof init?.body === 'string') {
      window.__requests.commands.push(JSON.parse(init.body).cmd);
    }
    return send.apply(this, arguments);
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready(page) {
  await page.waitForFunction(
    () => {
      const text = [...document.querySelectorAll('[role="log"]')]
        .map((log) => log.textContent || '')
        .join('');
      return /[$#%>❯]/.test(text) && !!window.app?.getSnapshot?.()?.context?.connected;
    },
    { timeout: 60000, polling: 100 },
  );
}

const counted = (page) =>
  page.evaluate(() => ({
    resources: window.__requests.resources.length,
    commands: window.__requests.commands.length,
  }));

/**
 * Run `act` and report what the page asked for because of it. `fresh` is for
 * a step that loads the document, which starts the page's record again.
 */
async function step(page, name, act, { fresh = false } = {}) {
  const before = fresh ? { resources: 0, commands: 0 } : await counted(page);
  await act();
  await sleep(QUIET_MS);
  const { resources, commands } = await page.evaluate(
    (from) => ({
      resources: window.__requests.resources.slice(from.resources),
      commands: window.__requests.commands.slice(from.commands),
    }),
    before,
  );
  const byCommand = {};
  for (const cmd of commands) byCommand[cmd] = (byCommand[cmd] ?? 0) + 1;
  const bundle = resources.filter((r) => /\/assets\/index-[^/]+\.(js|css)$/.test(r.name));
  return {
    name,
    requests: resources.length,
    bytes: resources.reduce((sum, r) => sum + r.bytes, 0),
    bundleBytes: bundle.reduce((sum, r) => sum + r.bytes, 0),
    commands: commands.length,
    byCommand,
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
  // A context of this run's own, so its cache starts empty and "cold" is cold.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addInitScript(recordRequests);
  const page = await context.newPage();
  const pane = () => page.locator(ACTIVE_LOG).first();
  const typeKeys = async (keys) => {
    for (const key of keys) {
      await page.keyboard.press(key);
      await sleep(300);
    }
  };

  const steps = [];
  steps.push(
    await step(
      page,
      'cold load',
      async () => {
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await ready(page);
      },
      { fresh: true },
    ),
  );
  steps.push(
    await step(
      page,
      'reload',
      async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready(page);
      },
      { fresh: true },
    ),
  );
  await pane().click();

  steps.push(await step(page, '5 keys, one client', () => typeKeys('abcde')));
  await page.keyboard.press('Control+u');

  const other = await context.newPage();
  await other.setViewportSize({ width: 900, height: 600 });
  await other.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await ready(other);
  await sleep(QUIET_MS);
  await page.bringToFront();
  await pane().click();
  steps.push(await step(page, '5 keys beside a smaller client', () => typeKeys('vwxyz')));
  await other.close();
  await page.keyboard.press('Control+u');
  await sleep(QUIET_MS);

  steps.push(
    await step(page, 'window edge dragged for a second', async () => {
      for (let i = 1; i <= 20; i++) {
        await page.setViewportSize({ width: 1400 - i * 15, height: 900 - i * 8 });
        await sleep(50);
      }
    }),
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(QUIET_MS);

  // A program that asked for mouse reports and swallows what it is sent.
  await page.keyboard.type("printf '\\033[?1003h\\033[?1006h'; cat >/dev/null\n");
  await sleep(QUIET_MS);
  const box = await pane().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  steps.push(
    await step(page, '5 wheel notches over a mouse app', async () => {
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 100);
        await sleep(50);
      }
    }),
  );
  await page.keyboard.press('Control+c');
  await page.keyboard.type("printf '\\033[?1003l\\033[?1006l'; seq 1 20000\n");
  await page.waitForFunction(
    (selector) => /(^|\n)20000\s*\n/.test(document.querySelector(selector)?.innerText ?? ''),
    ACTIVE_LOG,
    { timeout: 60000, polling: 100 },
  );
  await sleep(QUIET_MS);
  steps.push(
    await step(page, 'first scroll-up of a 20,000-line history', () => page.mouse.wheel(0, -300)),
  );

  await context.close();
  if (!CDP) await browser.close();

  const over = [];
  for (const result of steps) {
    for (const [what, most] of Object.entries(BUDGETS[result.name] ?? {})) {
      const got = result[what] ?? result.byCommand[what] ?? 0;
      if (got > most) over.push(`${result.name}: ${what} is ${got}, budget ${most}`);
    }
  }

  console.table(
    steps.map(({ name, requests, bytes, commands, byCommand }) => ({
      step: name,
      requests,
      bytes,
      commands,
      set_client_size: byCommand.set_client_size ?? 0,
    })),
  );
  const report = { schema: 1, url: URL_BASE, generatedAt: new Date().toISOString(), steps, over };
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote request report → ${OUT}`);
  }
  if (over.length > 0) {
    console.error(`over budget:\n  ${over.join('\n  ')}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('measure-requests failed:', e.stack || e.message);
  process.exit(1);
});
