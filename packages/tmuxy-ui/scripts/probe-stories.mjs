#!/usr/bin/env node
/**
 * Probe every Storybook story in a real Chromium and verify storyRendered
 * fires (which is how Storybook signals play function success).
 *
 * Usage: node scripts/probe-stories.mjs [port] [storyIdSubstring...]
 *
 * Expects a Storybook dev or static server already running on the given
 * port (default 6006). Exits non-zero if any story fails to render or its
 * play function throws. Optional substrings filter which stories run.
 *
 * Environment:
 *   PROBE_ARTIFACT_DIR  where a failing story's screenshot, DOM snapshot and
 *                       error text are written (default `probe-artifacts/`
 *                       beside package.json). CI uploads this directory.
 *   PROBE_CONCURRENCY   how many stories run at once (default 3).
 *   PROBE_CPU_THROTTLE  slow the renderer by this factor (default 1) to
 *                       reproduce a loaded CI runner locally.
 *   PROBE_A11Y          set to 0 to skip the axe pass (default: on).
 *   PROBE_REPEAT        run each selected story N times (default 1) and fail
 *                       if ANY attempt fails — how a story is shown to be
 *                       deterministic rather than lucky.
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  browser to drive.
 *
 * Accessibility: every story is also scanned with axe-core once its play
 * function has settled. `critical` and `serious` violations fail the job;
 * `moderate` and `minor` are printed and do not gate — a gate nobody can get
 * green gets switched off, which is worse than no gate.
 *
 * Quarantine: scripts/probe-quarantine.json lists stories whose failures are
 * reported but do not fail the job, and a11y rules that are reported but do
 * not gate, each with an expiry date. See the `_policy` block in that file.
 */

import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolvePath(SCRIPT_DIR, '..');

const args = process.argv.slice(2);
const PORT = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 6006;
const FILTERS = args;
const STORYBOOK_URL = `http://localhost:${PORT}`;
const PER_STORY_TIMEOUT_MS = 60000;
const CONCURRENCY = Math.max(1, Number(process.env.PROBE_CONCURRENCY || 3));
const REPEAT = Math.max(1, Number(process.env.PROBE_REPEAT || 1));
// CI runners are far slower than a dev machine, which is where these play
// functions fall over. Throttling the renderer reproduces that here.
const CPU_THROTTLE = Math.max(1, Number(process.env.PROBE_CPU_THROTTLE || 1));
const ARTIFACT_DIR = resolvePath(PACKAGE_DIR, process.env.PROBE_ARTIFACT_DIR || 'probe-artifacts');
const RUN_A11Y = process.env.PROBE_A11Y !== '0';
/** Impact levels that turn the job red; the rest are reported only. */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);
// axe-core ships with @storybook/addon-a11y, so it is already installed —
// the bundle is injected into each story page rather than added as a dep.
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/**
 * Read the quarantine list and check it against its own policy. A list that
 * breaks the policy stops the run: a silently over-long or undated list is how
 * quarantine turns into permanent cover for a broken suite.
 */
function loadQuarantine() {
  const path = resolvePath(SCRIPT_DIR, 'probe-quarantine.json');
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const max = file.maxEntries;
  const entries = file.entries ?? [];
  const problems = [];
  if (!Number.isInteger(max) || max < 1) problems.push('maxEntries must be a positive integer');
  if (!Array.isArray(entries)) problems.push('entries must be an array');
  if (Array.isArray(entries) && entries.length > max) {
    problems.push(
      `${entries.length} quarantined stories exceeds the cap of ${max} — fix or delete some before adding more`,
    );
  }
  const checkDated = (entry, where) => {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`${where}: missing reason`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) {
      problems.push(`${where}: expires must be a YYYY-MM-DD date`);
    } else if (Number.isNaN(Date.parse(entry.expires))) {
      problems.push(`${where}: expires is not a real date`);
    }
  };

  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const where = `entry ${JSON.stringify(entry.id ?? '(no id)')}`;
    if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${where}: missing id`);
    checkDated(entry, where);
    if (byId.has(entry.id)) problems.push(`${where}: listed twice`);
    byId.set(entry.id, entry);
  }

  // a11y entries shield ONE axe rule, on one story or (with id "*") on all of
  // them. Same policy: capped, dated, and each says why.
  const a11yMax = file.maxA11yEntries;
  const a11yEntries = file.a11yEntries ?? [];
  if (!Number.isInteger(a11yMax) || a11yMax < 1) {
    problems.push('maxA11yEntries must be a positive integer');
  }
  if (!Array.isArray(a11yEntries)) problems.push('a11yEntries must be an array');
  if (Array.isArray(a11yEntries) && a11yEntries.length > a11yMax) {
    problems.push(
      `${a11yEntries.length} quarantined a11y rules exceeds the cap of ${a11yMax} — fix some before adding more`,
    );
  }
  const a11y = [];
  for (const entry of Array.isArray(a11yEntries) ? a11yEntries : []) {
    const where = `a11y entry ${JSON.stringify(`${entry.id ?? '?'}/${entry.rule ?? '?'}`)}`;
    if (typeof entry.rule !== 'string' || entry.rule === '')
      problems.push(`${where}: missing rule`);
    if (typeof entry.id !== 'string' || entry.id === '') problems.push(`${where}: missing id`);
    checkDated(entry, where);
    a11y.push(entry);
  }

  if (problems.length > 0) {
    console.error('quarantine list rejected:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  const today = new Date().toISOString().slice(0, 10);
  return { byId, a11y, today, max };
}

const quarantine = loadQuarantine();

/** Whether a failure of `id` is shielded right now, and why it is or is not. */
function quarantineStatus(id) {
  const entry = quarantine.byId.get(id);
  if (!entry) return { shielded: false };
  if (entry.expires <= quarantine.today) {
    return { shielded: false, expired: true, entry };
  }
  return { shielded: true, entry };
}

/** The live a11y entry covering this story/rule pair, if there is one. */
function a11yShield(storyId, rule) {
  return quarantine.a11y.find(
    (e) => e.rule === rule && (e.id === '*' || e.id === storyId) && e.expires > quarantine.today,
  );
}

/**
 * axe over the rendered story, once its play function has settled.
 *
 * Scoped to the story root so Storybook's own preview chrome is not blamed on
 * the story, and limited to violations — the passes and incomplete sets are
 * large and nothing reads them.
 */
async function runAxe(page, storyId) {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const root = document.querySelector('#storybook-root') ?? document.body;
    // @storybook/addon-a11y bundles an axe of its own. The story URL turns its
    // automatic pass off, but a pass it had already begun is still in flight,
    // and axe refuses to run twice at once — so wait that one out.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const run = await window.axe.run(root, { resultTypes: ['violations'] });
        return run.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
        }));
      } catch (err) {
        if (!/already running/i.test(err?.message ?? '')) throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('axe never got a turn — the addon pass never finished');
  });
  return violations.map((v) => ({
    ...v,
    blocking: BLOCKING_IMPACTS.has(v.impact) && !a11yShield(storyId, v.id),
    shield: a11yShield(storyId, v.id),
  }));
}

async function fetchIndex() {
  const res = await fetch(`${STORYBOOK_URL}/index.json`);
  if (!res.ok) throw new Error(`storybook /index.json: ${res.status}`);
  const json = await res.json();
  const ids = Object.keys(json.entries).filter((id) => {
    const entry = json.entries[id];
    // `v86` stories (real tmux in the x86 emulator) are slow, network-dependent,
    // and nondeterministic — they run via probe-spikes.mjs on a single shared
    // engine page instead of this one-page-per-story probe.
    return entry.type === 'story' && !(entry.tags ?? []).includes('v86');
  });
  if (FILTERS.length === 0) return ids;
  return ids.filter((id) => FILTERS.some((f) => id.includes(f)));
}

async function writeArtifacts(page, label, result) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const base = resolvePath(ARTIFACT_DIR, label.replace(/[^a-z0-9._-]/gi, '_'));
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: false });
  } catch (err) {
    result.artifactError = err.message;
  }
  const lines = [
    `story:   ${result.id}`,
    `reason:  ${result.reason}`,
    `name:    ${result.name ?? '(none)'}`,
    `message: ${result.message ?? '(none)'}`,
    '',
    'stack:',
    result.stack ?? '(none)',
    '',
    `page errors (${result.pageErrors.length}):`,
    ...result.pageErrors.map((e) => `  ${e}`),
    '',
    `console errors (${result.consoleErrors.length}):`,
    ...result.consoleErrors.map((e) => `  ${e}`),
  ];
  writeFileSync(`${base}.txt`, `${lines.join('\n')}\n`);
  try {
    writeFileSync(`${base}.html`, await page.content());
  } catch {
    // The page can already be gone (a crashed renderer); the text report and
    // whatever screenshot landed are still worth keeping.
  }
  return `${base}.png`;
}

async function probeStory(browser, id, attempt) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  if (CPU_THROTTLE > 1) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
  }
  const consoleErrors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.stack || e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  let result;
  try {
    // `a11y.manual` turns the a11y addon's own axe pass off: this probe runs
    // axe itself, and two axe runs in one page collide.
    const url = `${STORYBOOK_URL}/iframe.html?id=${id}&viewMode=story&globals=a11y.manual:!true`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__STORYBOOK_PREVIEW__), { timeout: 20000 });

    const outcome = await page.evaluate(
      (timeoutMs) =>
        new Promise((resolve) => {
          // Everything Storybook knows about a failure, flattened. The payload
          // shape differs per event (an Error, a serialized error, a bare
          // string), and reporting only the event name is what made these
          // failures undiagnosable.
          const describe = (payload) => {
            const error = payload?.error ?? payload;
            const message =
              error?.message || (typeof payload === 'string' ? payload : '') || 'no message';
            return {
              message: String(message),
              stack: error?.stack ? String(error.stack) : undefined,
              name: error?.name ? String(error.name) : undefined,
            };
          };
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
          const failure = (reason) => (payload) => {
            clearTimeout(timer);
            resolve({ ok: false, reason, ...describe(payload) });
          };
          channel.on('storyRendered', success);
          channel.on('storyThrewException', failure('storyThrewException'));
          channel.on('storyErrored', failure('storyErrored'));
          channel.on('playFunctionThrewException', failure('playFunctionThrewException'));
          channel.on('storyMissing', failure('storyMissing'));
        }),
      PER_STORY_TIMEOUT_MS,
    );

    result = { id, attempt, ...outcome, consoleErrors, pageErrors };
    // Only a story that rendered has a DOM worth scanning; a failed one is
    // already being reported and its axe result would just be noise.
    if (result.ok && RUN_A11Y) {
      try {
        result.a11y = await runAxe(page, id);
        if (result.a11y.some((v) => v.blocking)) {
          result.ok = false;
          result.reason = 'a11y';
          result.message = result.a11y
            .filter((v) => v.blocking)
            .map((v) => `${v.impact} ${v.id}: ${v.help} [${v.nodes.join(', ')}]`)
            .join('\n');
        }
      } catch (err) {
        // A scan that could not run is not a story failure — a story that
        // navigates its own page tears the context out from under axe. Say so
        // and leave the verdict to the play function.
        result.a11ySkipped = err.message.split('\n')[0];
      }
    }
  } catch (err) {
    result = {
      id,
      attempt,
      ok: false,
      reason: 'probe-error',
      message: err.message,
      stack: err.stack,
      consoleErrors,
      pageErrors,
    };
  }
  if (!result.ok) {
    const label = REPEAT > 1 ? `${id}--attempt${attempt}` : id;
    result.artifact = await writeArtifacts(page, label, result);
  }
  await ctx.close();
  return result;
}

/**
 * A probe-level error that says nothing about the story.
 *
 * `storybook dev` compiles on demand and pushes the result over HMR, and some
 * of those updates reload the preview iframe — which tears the execution
 * context out from under whatever the probe was evaluating. It shows up when
 * several stories are compiling at once, so it is a concurrency artefact, not
 * a verdict: the same story passes on its own. Worth one more attempt on a
 * fresh context before it is called a failure.
 */
function isTornContext(result) {
  return (
    result.reason === 'probe-error' && /Execution context was destroyed/.test(result.message ?? '')
  );
}

async function runPool(items, n, fn) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        let result = await fn(item);
        if (isTornContext(result)) {
          process.stdout.write(`  RETRY ${result.id} (storybook reloaded the preview)\n`);
          result = await fn(item);
        }
        results.push(result);
        const status = quarantineStatus(result.id);
        const tag = result.ok ? 'PASS' : status.shielded ? 'FLAKY' : 'FAIL';
        const suffix = result.reason ? ` (${result.reason})` : '';
        process.stdout.write(`  ${tag}  ${result.id}${suffix}\n`);
      }
    }),
  );
  return results;
}

const ids = await fetchIndex();
if (ids.length === 0) {
  console.error('no stories matched');
  process.exit(1);
}
const jobs = ids.flatMap((id) =>
  Array.from({ length: REPEAT }, (_, i) => ({ id, attempt: i + 1 })),
);
console.log(
  `probing ${ids.length} stories on ${STORYBOOK_URL} (concurrency=${CONCURRENCY}, repeat=${REPEAT})…`,
);
console.log(`artifacts for failures → ${ARTIFACT_DIR}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  // Use the system chromium (always installed in the devcontainer); arm64 has
  // no Playwright-bundled build. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH overrides.
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
});

let results;
try {
  results = await runPool(jobs, CONCURRENCY, (job) => probeStory(browser, job.id, job.attempt));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
const blocking = failed.filter((r) => !quarantineStatus(r.id).shielded);
const shielded = failed.filter((r) => quarantineStatus(r.id).shielded);
console.log('');
console.log(
  `results: ${results.length - failed.length} passed, ${blocking.length} failed, ${shielded.length} quarantined-failure`,
);

const report = (list, heading) => {
  if (list.length === 0) return;
  console.log(`\n${heading}:`);
  for (const f of list) {
    const status = quarantineStatus(f.id);
    console.log(`  - ${f.id}${f.attempt > 1 ? ` (attempt ${f.attempt})` : ''}: ${f.reason}`);
    if (f.message) console.log(`      ${f.message.split('\n').join('\n      ')}`);
    if (f.stack) {
      for (const line of f.stack.split('\n').slice(0, 12)) console.log(`      ${line}`);
    }
    for (const e of f.pageErrors.slice(0, 2)) {
      console.log(`      pageerror: ${e.split('\n')[0]}`);
    }
    for (const e of f.consoleErrors.slice(0, 3)) {
      console.log(`      console: ${e.slice(0, 300)}`);
    }
    if (f.artifact) console.log(`      screenshot: ${f.artifact}`);
    if (status.entry) {
      console.log(`      quarantined until ${status.entry.expires}: ${status.entry.reason}`);
    }
  }
};

report(blocking, 'failures');
report(shielded, 'quarantined failures (reported, not blocking)');

// Every a11y violation is printed, whatever its impact — the ones that gate
// are already in the failure report above, and the rest are the backlog.
const nonGating = new Map();
for (const r of results) {
  for (const v of r.a11y ?? []) {
    if (v.blocking) continue;
    const key = `${r.id}\u0000${v.id}`;
    if (!nonGating.has(key)) nonGating.set(key, { story: r.id, ...v });
  }
}
if (nonGating.size > 0) {
  console.log('\naccessibility findings that do not gate:');
  for (const v of nonGating.values()) {
    const why = v.shield ? `quarantined until ${v.shield.expires}: ${v.shield.reason}` : 'reported';
    console.log(`  - ${v.story} [${v.impact}] ${v.id}: ${v.help} (${why})`);
    console.log(`      ${v.nodes.join(', ')}`);
    console.log(`      ${v.helpUrl}`);
  }
}
const a11yExpired = quarantine.a11y.filter((e) => e.expires <= quarantine.today);
if (a11yExpired.length > 0) {
  console.log('\na11y quarantine entries that have EXPIRED and no longer shield anything:');
  for (const e of a11yExpired) {
    console.log(`  - ${e.id} / ${e.rule} (expired ${e.expires}): ${e.reason}`);
  }
}

// A quarantined story that never failed has earned its way out of the list.
const everFailed = new Set(failed.map((r) => r.id));
const probed = new Set(ids);
const ready = [...quarantine.byId.values()].filter(
  (e) => probed.has(e.id) && !everFailed.has(e.id),
);
if (ready.length > 0) {
  console.log('\nquarantined stories that passed — remove them from probe-quarantine.json:');
  for (const e of ready) console.log(`  - ${e.id} (expires ${e.expires})`);
}
const expired = [...quarantine.byId.values()].filter((e) => e.expires <= quarantine.today);
if (expired.length > 0) {
  console.log('\nquarantine entries that have EXPIRED and no longer shield anything:');
  for (const e of expired) console.log(`  - ${e.id} (expired ${e.expires}): ${e.reason}`);
}

process.exit(blocking.length === 0 ? 0 : 1);
