#!/usr/bin/env node
/**
 * Interaction-latency harness (CI target).
 *
 * Measures the wall-clock cost of the handful of interactions a tmuxy user
 * performs constantly — typing, moving between panes, splitting, zooming,
 * switching tabs — from the real browser `keydown` to the first DOM change
 * that shows the result. Same arm-on-keydown / resolve-on-mutation technique
 * as `measure-keypaint.mjs`, generalized past a single keystroke and shaped
 * for a machine-readable report.
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
 * Usage:
 *   node measure-interactions.mjs [--url URL] [--samples N] [--out FILE]
 *                                 [--label NAME] [--session NAME]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

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

// A sample that takes longer than this is recorded as a timeout, not a
// datapoint — a stuck interaction must not masquerade as a slow one.
const SAMPLE_TIMEOUT_MS = 5000;
// Quiet gap between samples so one interaction's trailing state updates never
// land inside the next one's measurement window.
const SETTLE_MS = 450;

const shortSha = () => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

// ==================== In-page instrumentation ====================

/**
 * Install the probes and the armer. Probes are pure readers of what the user
 * can see; the armer stamps the real keydown and resolves on the first probe
 * change after it.
 */
async function installProbes(page) {
  await page.evaluate(() => {
    const activeLog = () => document.querySelector('.pane-layout-item.pane-active [role="log"]');

    // Both selectors are deliberately narrow: `data-pane-id` also lands on the
    // terminal inside each pane, on floats, and on sidebar-tree rows, and
    // `role="tab"` is used by pane-group headers as well as the tab strip.
    // Counting either loosely double-counts a single pane or window.
    window.__perfProbes = {
      activePane: () =>
        document.querySelector('.pane-layout-item.pane-active')?.getAttribute('data-pane-id') ?? '',
      paneCount: () => document.querySelectorAll('.pane-layout-item[data-pane-id]').length,
      zoomed: () => document.querySelectorAll('.pane-zoomed').length,
      activeTab: () =>
        document
          .querySelector('.tab-list [role="tab"][aria-selected="true"]')
          ?.getAttribute('aria-label') ?? '',
      // Occurrences of a specific character in the focused pane, so an
      // unrelated repaint (a clock, a spinner) cannot resolve the sample.
      charCount: (ch) => (activeLog()?.textContent ?? '').split(ch).length - 1,
    };

    window.__perfArm = (probeName, arg, timeoutMs) =>
      new Promise((resolve) => {
        const probe = window.__perfProbes[probeName];
        const base = probe(arg);
        let t0 = 0;
        let settled = false;

        const onKey = () => {
          if (!t0) t0 = performance.now();
        };
        document.addEventListener('keydown', onKey, { capture: true });

        const finish = (value) => {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearInterval(poll);
          clearTimeout(deadline);
          document.removeEventListener('keydown', onKey, { capture: true });
          resolve(value);
        };

        const check = () => {
          if (!t0) return; // a mutation before the keydown is not ours
          if (probe(arg) !== base) finish(performance.now() - t0);
        };

        const observer = new MutationObserver(check);
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        // The observer catches the common case; the poll covers a change that
        // lands as a property/style update the observer is not watching.
        const poll = setInterval(check, 8);
        const deadline = setTimeout(() => finish(-1), timeoutMs);
      });
  });
}

// ==================== Driving ====================

async function readPrefix(page) {
  const raw = await page.evaluate(
    () => window.app?.getSnapshot?.()?.context?.keybindings?.prefix_key,
  );
  if (typeof raw === 'string' && raw.startsWith('C-'))
    return { modifier: 'Control', key: raw.slice(2) };
  return { modifier: 'Control', key: 'b' };
}

/** Send `prefix` then `key`, as a user does. */
async function prefixKey(page, prefix, key) {
  await page.keyboard.press(`${prefix.modifier}+${prefix.key}`);
  await page.waitForTimeout(60);
  await page.keyboard.press(key);
}

/**
 * Run one interaction `samples` times.
 *
 * `act` performs the keystroke that starts the clock; `probe`/`probeArg` name
 * the observable that stops it. `between` runs untimed after each sample to
 * put the session back where the next sample expects it.
 */
async function measure(page, { name, samples, act, probe, probeArg = null, between = null }) {
  const values = [];
  let timeouts = 0;

  // One discarded warm-up: the first sample of an interaction pays for a cold
  // binding lookup and whatever the previous interaction left settling, and it
  // is the sample most likely to race the armer. Measuring it would put a
  // one-off cost into every p95.
  for (let round = 0; round <= samples; round++) {
    const warmup = round === 0;
    const armed = page.evaluate(
      ([p, a, t]) => window.__perfArm(p, a, t),
      [probe, typeof probeArg === 'function' ? probeArg(round) : probeArg, SAMPLE_TIMEOUT_MS],
    );
    await page.waitForTimeout(40); // let the listener attach before the key
    await act(round);
    const ms = await armed;
    if (!warmup) {
      if (ms > 0) values.push(ms);
      else timeouts++;
    }
    await page.waitForTimeout(SETTLE_MS);
    if (between) await between(round);
    await page.waitForTimeout(SETTLE_MS);
  }

  return { name, samples: values.length, timeouts, values };
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
const round1 = (n) => Math.round(n * 10) / 10;

function summarize(result) {
  const sorted = [...result.values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      name: result.name,
      samples: 0,
      timeouts: result.timeouts,
      p50: null,
      p95: null,
      max: null,
    };
  }
  return {
    name: result.name,
    samples: sorted.length,
    timeouts: result.timeouts,
    p50: round1(pct(sorted, 0.5)),
    p95: round1(pct(sorted, 0.95)),
    max: round1(sorted[sorted.length - 1]),
  };
}

// ==================== Session shaping ====================

/** Wait until the UI is connected and a shell prompt has rendered. */
async function waitForReady(page) {
  await page.waitForSelector('[role="log"]', { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const text = [...document.querySelectorAll('[role="log"]')]
        .map((l) => l.textContent || '')
        .join('');
      // A prompt, not a length: a fresh session's prompt can be as short as
      // `~❯ `, and a byte-count threshold rejects it as "not ready yet".
      return (
        /[$#%>❯]/.test(text) &&
        text.trim().length > 0 &&
        window.app?.getSnapshot?.()?.context?.connected
      );
    },
    { timeout: 30000, polling: 100 },
  );
  // Keybindings arrive on their own SSE event; a prefix-bound key pressed
  // before they land is silently dropped by the keyboard actor.
  await page.waitForFunction(
    () => (window.app?.getSnapshot?.()?.context?.keybindings?.prefix_bindings ?? []).length > 0,
    { timeout: 15000, polling: 100 },
  );
  await page.waitForTimeout(1500);
}

async function paneCount(page) {
  return page.evaluate(() => document.querySelectorAll('.pane-layout-item[data-pane-id]').length);
}

async function tabCount(page) {
  return page.evaluate(() => document.querySelectorAll('.tab-list [role="tab"]').length);
}

/** Grow/shrink the session to exactly `want` panes, through the real bindings. */
async function ensurePanes(page, prefix, want) {
  for (let guard = 0; guard < 8 && (await paneCount(page)) < want; guard++) {
    await prefixKey(page, prefix, '|');
    await page.waitForTimeout(1200);
  }
  for (let guard = 0; guard < 8 && (await paneCount(page)) > want; guard++) {
    await page.keyboard.type('exit\n');
    await page.waitForTimeout(1200);
  }
}

async function ensureTabs(page, prefix, want) {
  for (let guard = 0; guard < 4 && (await tabCount(page)) < want; guard++) {
    await prefixKey(page, prefix, 'c');
    await page.waitForTimeout(1500);
  }
}

// ==================== Main ====================

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
  const page = await context.newPage();
  if (CDP) await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForReady(page);
  await installProbes(page);

  const prefix = await readPrefix(page);
  await page
    .locator('.pane-layout-item[data-pane-id] [role="log"]')
    .first()
    .click({ timeout: 5000 });
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(500);

  const results = [];

  // --- keystroke echo: the reference every other number is divided by ---
  // A distinct letter per sample so the probe counts THIS keystroke's echo.
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  results.push(
    await measure(page, {
      name: 'key-echo',
      samples: SAMPLES,
      probe: 'charCount',
      probeArg: (i) => LETTERS[i % 26],
      act: (i) => page.keyboard.press(LETTERS[i % 26]),
    }),
  );
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(500);

  // --- pane navigation: the interaction this harness exists for ---
  await ensurePanes(page, prefix, 2);
  results.push(
    await measure(page, {
      name: 'pane-nav-keyboard',
      samples: SAMPLES,
      probe: 'activePane',
      act: (i) => page.keyboard.press(i % 2 === 0 ? 'Control+ArrowRight' : 'Control+ArrowLeft'),
    }),
  );

  // --- zoom toggle ---
  results.push(
    await measure(page, {
      name: 'pane-zoom-toggle',
      samples: SAMPLES,
      probe: 'zoomed',
      act: () => prefixKey(page, prefix, 'z'),
    }),
  );
  // Leave zoom off however the last sample landed.
  if ((await page.evaluate(() => document.querySelectorAll('.pane-zoomed').length)) > 0) {
    await prefixKey(page, prefix, 'z');
    await page.waitForTimeout(600);
  }

  // --- split: timed create, untimed teardown back to two panes ---
  results.push(
    await measure(page, {
      name: 'pane-split',
      samples: SAMPLES,
      probe: 'paneCount',
      act: () => prefixKey(page, prefix, '|'),
      between: async () => {
        await page.keyboard.type('exit\n');
        await page.waitForTimeout(900);
      },
    }),
  );
  await ensurePanes(page, prefix, 2);

  // --- tab switch ---
  await ensureTabs(page, prefix, 2);
  results.push(
    await measure(page, {
      name: 'tab-switch',
      samples: SAMPLES,
      probe: 'activeTab',
      act: () => page.keyboard.press('Control+Tab'),
    }),
  );

  // A CDP browser belongs to the developer, not to us — close only the tab.
  if (CDP) await page.close();
  else await browser.close();

  const summaries = results.map(summarize);
  const reference = summaries.find((s) => s.name === 'key-echo');
  const refP50 = reference && reference.p50 ? reference.p50 : null;

  const report = {
    schema: 1,
    label: LABEL,
    generatedAt: new Date().toISOString(),
    commit: shortSha(),
    platform: `${process.platform}-${process.arch}`,
    url: URL,
    samplesRequested: SAMPLES,
    // Every interaction as a multiple of the keystroke round trip measured on
    // this same machine in this same run. Machine-speed-independent, which is
    // what makes a CI budget possible at all.
    reference: 'key-echo',
    interactions: summaries.map((s) => ({
      ...s,
      ratioToReference: refP50 && s.p50 ? round1(s.p50 / refP50) : null,
    })),
  };

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
