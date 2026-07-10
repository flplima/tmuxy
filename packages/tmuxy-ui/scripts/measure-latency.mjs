#!/usr/bin/env node
/**
 * Axis-B measurement runner (throwaway harness, not a CI target).
 *
 * Drives a real browser through the full input→paint pipeline and reads the
 * dev-gated latencyTracker (window.__tmuxyLatency) to report the round-trip
 * distribution. Run once per RTT condition (direct or through latency-proxy).
 *
 * Usage:
 *   node measure-latency.mjs <label> <url> [--keys N] [--spacing MS] [--burst]
 *
 * Requires PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium on arm64.
 */
import { chromium } from 'playwright';

const [, , label, url, ...rest] = process.argv;
if (!label || !url) {
  console.error('usage: measure-latency.mjs <label> <url> [--keys N] [--spacing MS] [--burst]');
  process.exit(2);
}
let keys = 26;
let spacing = 400;
let burst = false;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--keys') keys = Number(rest[++i]);
  else if (rest[i] === '--spacing') spacing = Number(rest[++i]);
  else if (rest[i] === '--burst') burst = true;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[role="log"]', { timeout: 15000 });
  // Wait for the pipeline: prompt visible AND XState reports connected.
  await page.waitForFunction(
    () => {
      const logs = document.querySelectorAll('[role="log"]');
      const content = Array.from(logs).map((l) => l.textContent || '').join('\n');
      const hasPrompt = content.length > 5 && /[$#%>❯]/.test(content);
      const connected = window.app?.getSnapshot?.()?.context?.connected;
      return hasPrompt && connected;
    },
    { timeout: 20000, polling: 100 },
  );
  // Settle the initial burst of boot updates.
  await page.waitForTimeout(1500);

  // Focus the pane so keystrokes route.
  await page.locator('[data-pane-id]').first().click({ timeout: 5000 });
  await page.waitForTimeout(300);

  // Enable + clear any typed prompt, then reset the tracker.
  await page.evaluate(() => window.__tmuxyLatency?.setEnabled(true));
  await page.keyboard.press('Control+u'); // kill line
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__tmuxyLatency?.reset());

  if (burst) {
    // Throughput/backlog: flood the server→client render path with a big output
    // burst and sample the tracker as it drains.
    await page.keyboard.type('seq 1 3000', { delay: 5 });
    let peakPending = 0;
    let peakRate = 0;
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    while (Date.now() - t0 < 5000) {
      const s = await page.evaluate(() => window.__tmuxyLatency?.getSnapshot());
      if (s) {
        peakPending = Math.max(peakPending, s.pending);
        peakRate = Math.max(peakRate, s.updates.ratePerSec);
      }
      await page.waitForTimeout(150);
    }
    const snap = await page.evaluate(() => window.__tmuxyLatency?.getSnapshot());
    console.log(JSON.stringify({ label, mode: 'burst', peakPending, peakRate, snap }, null, 2));
  } else {
    // Clean per-keystroke round trips: press letters spaced > KeyBatcher window.
    for (let i = 0; i < keys; i++) {
      await page.keyboard.press(LETTERS[i % 26]);
      await page.waitForTimeout(spacing);
    }
    await page.waitForTimeout(800); // let the final update land
    const snap = await page.evaluate(() => window.__tmuxyLatency?.getSnapshot());
    console.log(JSON.stringify({ label, mode: 'keys', keys, spacing, snap }, null, 2));
  }

  // Cleanup the prompt line so the next run starts clean.
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(200);
  await browser.close();
}

main().catch((e) => {
  console.error('measure failed:', e.message);
  process.exit(1);
});
