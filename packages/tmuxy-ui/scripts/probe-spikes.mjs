#!/usr/bin/env node
/**
 * Probe every `v86`-tagged Storybook story in ONE Chromium page.
 *
 * The v86 stories share a process-wide emulator engine (V86Engine's
 * getSharedEngine): the first story cold-boots (~5s), every later story
 * restores the pinned snapshot (~1s). The regular probe-stories.mjs opens a
 * fresh page per story, which re-boots the machine every time and excludes
 * these stories entirely — this runner navigates between stories in-page via
 * the Storybook preview channel so the shared engine actually gets exercised
 * (including the SharedIsolation / SharedReattachStability reset guards).
 *
 * Usage: node scripts/probe-spikes.mjs [port] [storyIdSubstring...]
 *
 * Expects a Storybook dev or static server already running on the given port
 * (default 6006). Optional substrings filter which v86 stories run. Exits
 * non-zero if any story fails to render or its play function throws.
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const PORT = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 6006;
const FILTERS = args;
const STORYBOOK_URL = `http://localhost:${PORT}`;
const PER_STORY_TIMEOUT_MS = 240000;

async function fetchIndex() {
  const res = await fetch(`${STORYBOOK_URL}/index.json`);
  if (!res.ok) throw new Error(`storybook /index.json: ${res.status}`);
  const json = await res.json();
  const ids = Object.keys(json.entries).filter((id) => {
    const entry = json.entries[id];
    return entry.type === 'story' && (entry.tags ?? []).includes('v86');
  });
  if (FILTERS.length === 0) return ids;
  return ids.filter((id) => FILTERS.some((f) => id.includes(f)));
}

const ids = await fetchIndex();
if (ids.length === 0) {
  console.error('no v86 stories matched');
  process.exit(1);
}
console.log(`probing ${ids.length} v86 stories on ${STORYBOOK_URL} in a single shared page…`);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Console-error accounting (parity with probe-stories.mjs). The shared page
// spans every story, so errors are attributed to whichever story is on screen
// when they fire — good enough to point a human at the culprit.
let currentStoryId = ids[0];
const consoleErrorsByStory = new Map();
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const list = consoleErrorsByStory.get(currentStoryId) ?? [];
  list.push(msg.text());
  consoleErrorsByStory.set(currentStoryId, list);
});

// Install the channel listeners as soon as the preview exists so the first
// story's storyRendered can't slip past between page load and instrumentation.
await page.addInitScript(() => {
  const timer = setInterval(() => {
    const preview = window.__STORYBOOK_PREVIEW__;
    if (!preview?.channel) return;
    clearInterval(timer);
    window.__probeEvents = [];
    const record = (ev) => (payload) =>
      window.__probeEvents.push({
        ev,
        // storyRendered's payload is the story id; error events carry objects.
        storyId: typeof payload === 'string' ? payload : (payload?.storyId ?? null),
        message: payload?.error?.message || payload?.message || undefined,
      });
    for (const ev of [
      'storyRendered',
      'playFunctionThrewException',
      'storyThrewException',
      'storyErrored',
      'storyMissing',
    ]) {
      preview.channel.on(ev, record(ev));
    }
  }, 50);
});

await page.goto(`${STORYBOOK_URL}/iframe.html?id=${ids[0]}&viewMode=story`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});

async function awaitOutcome(id) {
  // Success must name THIS story (stale rendered events from the previous
  // story can trail in); failure events count regardless — they abort the run
  // for the story on screen.
  try {
    await page.waitForFunction(
      (storyId) =>
        (window.__probeEvents ?? []).some(
          (e) => e.ev !== 'storyRendered' || e.storyId === storyId,
        ),
      id,
      { timeout: PER_STORY_TIMEOUT_MS },
    );
  } catch {
    return { id, ok: false, reason: 'timeout' };
  }
  const events = await page.evaluate(() => window.__probeEvents);
  const failure = events.find((e) => e.ev !== 'storyRendered');
  if (failure) return { id, ok: false, reason: failure.ev, message: failure.message };
  return { id, ok: true };
}

// channel.emit only sends OUTBOUND (to a manager that doesn't exist on
// iframe.html) — drive the preview's own selection handler directly.
const selectStory = (storyId) =>
  page.evaluate((s) => {
    window.__probeEvents = [];
    window.__STORYBOOK_PREVIEW__.onSetCurrentStory({ storyId: s, viewMode: 'story' });
  }, storyId);

// Navigate the page fresh to a story — this tears down the shared v86 engine
// (JS context is discarded) and cold-boots a new one. The addInitScript
// channel listeners re-install on every load, so probeEvents keep working.
const loadStory = (storyId) =>
  page.goto(`${STORYBOOK_URL}/iframe.html?id=${storyId}&viewMode=story`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

const results = [];
for (let i = 0; i < ids.length; i++) {
  const id = ids[i];
  currentStoryId = id;
  if (i > 0) {
    {
      // Let the finished story's teardown/trailing engine traffic settle
      // before rewinding the shared machine — switching at storyRendered+0ms
      // leaves the next mount racing the previous story's outbound bytes.
      // (A periodic full page reload was tried to clear accumulated engine
      // drift, but it wiped document-level singletons like the injected
      // `#tmuxy-theme` stylesheet mid-run; the core provisional-window-index
      // fix removed the biggest accumulation source — tab-create stories no
      // longer take tens of seconds — so a snapshot reset between stories is
      // enough. A cold boot still happens on a failing story's retry below.)
      await new Promise((r) => setTimeout(r, 1500));
      await selectStory(id);
    }
  }
  const started = Date.now();
  let result = await awaitOutcome(id);
  let retried = false;
  if (!result.ok) {
    // Retry on a FRESH cold-booted engine: most deep-run failures are
    // accumulated-degradation, not real defects, and a full page reload clears
    // all of it (JS timers, serial backlog, WASM/guest drift) — far more
    // reliable than a snapshot-only bounce. A genuine defect still reproduces
    // deterministically on the clean engine.
    await loadStory(id);
    result = await awaitOutcome(id);
    retried = true;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${result.ok ? 'PASS' : 'FAIL'}${retried ? ' (retry)' : ''}  ${id} (${secs}s)${
      result.ok ? '' : ` — ${result.reason}${result.message ? `: ${result.message.slice(0, 200)}` : ''}`
    }`,
  );
  results.push(result);
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`results: ${results.length - failed.length} passed, ${failed.length} failed`);
if (pageErrors.length > 0) {
  console.log(`pageerrors during run: ${pageErrors.length}`);
  for (const e of pageErrors.slice(0, 5)) console.log(`  ${e.slice(0, 200)}`);
}
if (consoleErrorsByStory.size > 0) {
  const total = [...consoleErrorsByStory.values()].reduce((n, list) => n + list.length, 0);
  console.log(`console errors during run: ${total}`);
  for (const [story, errors] of consoleErrorsByStory) {
    console.log(`  ${story} (${errors.length}):`);
    for (const e of errors.slice(0, 3)) console.log(`    ${e.slice(0, 200)}`);
  }
}
process.exit(failed.length === 0 ? 0 : 1);
