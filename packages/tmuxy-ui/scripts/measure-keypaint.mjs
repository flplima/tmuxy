#!/usr/bin/env node
/**
 * Keydown→paint measurement (throwaway harness, not a CI target).
 *
 * Unlike measure-latency.mjs (which reads the latencyTracker: send→apply,
 * blind to client-side batching delays), this measures from the browser
 * keydown event to the first DOM mutation of the pane — the full
 * user-perceived echo latency including the KeyBatcher window.
 *
 * Usage: node measure-keypaint.mjs <label> <url> [--keys N]
 */
import { chromium } from 'playwright';

const [, , label, url, ...rest] = process.argv;
if (!label || !url) {
  console.error('usage: measure-keypaint.mjs <label> <url> [--keys N]');
  process.exit(2);
}
let keys = 20;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--keys') keys = Number(rest[++i]);
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[role="log"]', { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const c = [...document.querySelectorAll('[role="log"]')].map((l) => l.textContent || '').join('');
      return c.length > 5 && /[$#%>❯]/.test(c) && window.app?.getSnapshot?.()?.context?.connected;
    },
    { timeout: 20000, polling: 100 },
  );
  await page.waitForTimeout(1500);
  await page.locator('[data-pane-id]').first().click({ timeout: 5000 });
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(800);

  const samples = [];
  for (let i = 0; i < keys; i++) {
    const letter = LETTERS[i % 26];
    // Arm: capture keydown time, resolve only when THIS letter's echo renders
    // (occurrence count rises) — unrelated periodic mutations don't count.
    const armed = page.evaluate(
      (ch) =>
        new Promise((resolve) => {
          const pane = document.querySelector('[role="log"]');
          const countOf = () => ((pane.textContent || '').split(ch).length - 1);
          const base = countOf();
          let t0 = 0;
          document.addEventListener(
            'keydown',
            () => {
              t0 = performance.now();
            },
            { capture: true, once: true },
          );
          const mo = new MutationObserver(() => {
            if (t0 === 0) return; // mutation before the keydown — ignore
            if (countOf() > base) {
              mo.disconnect();
              resolve(performance.now() - t0);
            }
          });
          mo.observe(pane, { childList: true, subtree: true, characterData: true });
          setTimeout(() => {
            mo.disconnect();
            resolve(-1); // timed out
          }, 3000);
        }),
      letter,
    );
    await page.waitForTimeout(50); // let the listener arm
    await page.keyboard.press(letter);
    const latency = await armed;
    if (latency > 0) samples.push(latency);
    await page.waitForTimeout(400); // isolate keystrokes
  }

  await page.keyboard.press('Control+u');
  await page.waitForTimeout(200);
  await browser.close();

  samples.sort((a, b) => a - b);
  const pct = (q) => samples[Math.min(samples.length - 1, Math.floor(q * (samples.length - 1)))];
  console.log(
    JSON.stringify(
      {
        label,
        count: samples.length,
        p50: Math.round(pct(0.5) * 10) / 10,
        p95: Math.round(pct(0.95) * 10) / 10,
        max: Math.round(samples[samples.length - 1] * 10) / 10,
        mean: Math.round((samples.reduce((n, v) => n + v, 0) / samples.length) * 10) / 10,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('measure failed:', e.message);
  process.exit(1);
});
