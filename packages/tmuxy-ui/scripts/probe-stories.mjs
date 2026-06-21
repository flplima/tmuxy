#!/usr/bin/env node
/**
 * Probe every Storybook story in a real Chromium and verify storyRendered
 * fires (which is how Storybook signals play function success).
 *
 * Usage: node scripts/probe-stories.mjs [port]
 *
 * Expects a Storybook dev or static server already running on the given
 * port (default 6006). Exits non-zero if any story fails to render or its
 * play function throws.
 */

import { chromium } from 'playwright';

const PORT = Number(process.argv[2] || 6006);
const STORYBOOK_URL = `http://localhost:${PORT}`;
const PER_STORY_TIMEOUT_MS = 60000;
const CONCURRENCY = 3;

async function fetchIndex() {
  const res = await fetch(`${STORYBOOK_URL}/index.json`);
  if (!res.ok) throw new Error(`storybook /index.json: ${res.status}`);
  const json = await res.json();
  return Object.keys(json.entries).filter((id) => json.entries[id].type === 'story');
}

async function probeStory(browser, id) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  try {
    const url = `${STORYBOOK_URL}/iframe.html?id=${id}&viewMode=story`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__STORYBOOK_PREVIEW__), { timeout: 20000 });

    const outcome = await page.evaluate(
      (timeoutMs) =>
        new Promise((resolve) => {
          const preview = window.__STORYBOOK_PREVIEW__;
          const channel = preview?.channel;
          if (!channel) {
            resolve({ ok: false, reason: 'no channel' });
            return;
          }
          const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
          const success = () => {
            clearTimeout(timer);
            resolve({ ok: true });
          };
          const failure = (reason, payload) => {
            clearTimeout(timer);
            const msg =
              payload?.error?.message ||
              payload?.message ||
              (typeof payload === 'string' ? payload : JSON.stringify(payload));
            resolve({ ok: false, reason, message: msg });
          };
          channel.on('storyRendered', success);
          channel.on('storyThrewException', (p) => failure('storyThrewException', p));
          channel.on('storyErrored', (p) => failure('storyErrored', p));
          channel.on('playFunctionThrewException', (p) => failure('playFunctionThrewException', p));
          channel.on('storyMissing', () => failure('storyMissing', null));
        }),
      PER_STORY_TIMEOUT_MS,
    );

    return {
      id,
      ok: outcome.ok,
      reason: outcome.reason,
      message: outcome.message,
      consoleErrors,
      pageErrors,
    };
  } catch (err) {
    return {
      id,
      ok: false,
      reason: 'probe-error',
      message: err.message,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await ctx.close();
  }
}

async function runPool(items, n, fn) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        const result = await fn(item);
        results.push(result);
        const tag = result.ok ? 'PASS' : 'FAIL';
        process.stdout.write(`  ${tag}  ${result.id}${result.reason ? ` (${result.reason})` : ''}\n`);
      }
    }),
  );
  return results;
}

const ids = await fetchIndex();
console.log(`probing ${ids.length} stories on ${STORYBOOK_URL} (concurrency=${CONCURRENCY})…`);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  // Use the system chromium (always installed in the devcontainer); arm64 has
  // no Playwright-bundled build. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH overrides.
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
});

let results;
try {
  results = await runPool(ids, CONCURRENCY, (id) => probeStory(browser, id));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;
console.log('');
console.log(`results: ${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log('\nfailures:');
  for (const f of failed) {
    console.log(`  - ${f.id}: ${f.reason}${f.message ? ` — ${f.message.slice(0, 240)}` : ''}`);
    if (f.pageErrors.length > 0) {
      console.log(`      pageerror: ${f.pageErrors[0].slice(0, 200)}`);
    }
  }
}
process.exit(failed.length === 0 ? 0 : 1);
