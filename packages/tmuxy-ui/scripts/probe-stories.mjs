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

import { resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import {
  a11yShield as shieldFor,
  loadQuarantine,
  quarantineStatus as statusFor,
} from './probe-quarantine.mjs';
import {
  ARTIFACT_DIR,
  SCRIPT_DIR,
  fetchStoryIds,
  launchChromium,
  parseProbeArgs,
  printFailures,
  writeArtifacts,
} from './lib/probe-common.mjs';

const { filters: FILTERS, storybookUrl: STORYBOOK_URL } = parseProbeArgs(process.argv.slice(2));
const PER_STORY_TIMEOUT_MS = 60000;
const CONCURRENCY = Math.max(1, Number(process.env.PROBE_CONCURRENCY || 3));
const REPEAT = Math.max(1, Number(process.env.PROBE_REPEAT || 1));
// CI runners are far slower than a dev machine, which is where these play
// functions fall over. Throttling the renderer reproduces that here.
const CPU_THROTTLE = Math.max(1, Number(process.env.PROBE_CPU_THROTTLE || 1));
const RUN_A11Y = process.env.PROBE_A11Y !== '0';
/** Impact levels that turn the job red; the rest are reported only. */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);
// axe-core ships with @storybook/addon-a11y, so it is already installed —
// the bundle is injected into each story page rather than added as a dep.
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const quarantine = loadQuarantine(resolvePath(SCRIPT_DIR, 'probe-quarantine.json'));
const quarantineStatus = (id) => statusFor(quarantine, id);
const a11yShield = (storyId, rule) => shieldFor(quarantine, storyId, rule);

/**
 * axe over the rendered story, once its play function has settled.
 *
 * Scoped to the story root so Storybook's own preview chrome is not blamed on
 * the story, and limited to violations — the passes and incomplete sets are
 * large and nothing reads them.
 */
async function runAxe(page, storyId) {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async (axeTimeoutMs) => {
    const root = document.querySelector('#storybook-root') ?? document.body;
    // @storybook/addon-a11y bundles an axe of its own. The story URL turns its
    // automatic pass off, but a pass it had already begun is still in flight,
    // and axe refuses to run twice at once — so wait that one out.
    // axe gets its own deadline, IN THE PAGE. `page.evaluate` has no timeout of
    // its own, so an axe pass that never settles hangs the probe on a story
    // that already rendered and already passed its own assertions — which is
    // what `mocked-app-sidebar--right-click-context-menus` did: the story is
    // fine, the scan of its tree is what never came back. A sentinel rather
    // than a rejection, so the caller can say "the scan timed out" instead of
    // reporting the story as broken.
    const withDeadline = (promise) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve('axe-timeout'), axeTimeoutMs)),
      ]);

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const run = await withDeadline(window.axe.run(root, { resultTypes: ['violations'] }));
        if (run === 'axe-timeout') return 'axe-timeout';
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
  }, AXE_TIMEOUT_MS);
  // A scan that ran out of time reports nothing rather than failing the story:
  // the story itself rendered and asserted fine, and a missing a11y result is
  // not evidence of a violation.
  if (violations === 'axe-timeout') {
    process.stdout.write(`  NOTE  ${storyId}: a11y scan timed out after ${AXE_TIMEOUT_MS}ms\n`);
    return [];
  }
  return violations.map((v) => ({
    ...v,
    blocking: BLOCKING_IMPACTS.has(v.impact) && !a11yShield(storyId, v.id),
    shield: a11yShield(storyId, v.id),
  }));
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

/**
 * The longest one story may take before it is called a failure.
 *
 * Nothing in the probe was bounded, and a single story that never settles
 * therefore stopped the whole pool: `page.evaluate` has no timeout of its own,
 * so an `axe.run` that neither resolves nor rejects inside the browser simply
 * never came back. The job then sat until GitHub killed it at 30 minutes, with
 * no report and no clue which story it was — `storybook-probe` was cancelled in
 * EVERY run for exactly that reason.
 *
 * It MUST sit above the sum of the bounded steps inside one story, or it
 * masks the very diagnosis it exists to produce: `goto` (30s) +
 * `__STORYBOOK_PREVIEW__` (20s) + the play function (`PER_STORY_TIMEOUT_MS`,
 * 60s) + the a11y scan (`AXE_TIMEOUT_MS`, 20s) is 130s, so a 120s deadline
 * fired first and stamped `probe-timeout` over an inner timeout that would
 * have named the real reason. Raising one of those budgets means raising this.
 *
 * Generous on purpose besides: a cold CI runner compiling a story on demand is
 * slow, and this must not turn slowness into a failure. It is here to catch a
 * story that hangs with no bound of its own at all — the case that used to sit
 * until GitHub killed the job — not to police speed.
 */
const STORY_TIMEOUT_MS = Number(process.env.PROBE_STORY_TIMEOUT_MS ?? 180000);

/**
 * The longest one axe pass may take before its result is given up on.
 *
 * Well above a real scan (most are milliseconds; the heaviest trees are a
 * second or two) and far below the story deadline, so a stalled SCAN is
 * reported as exactly that rather than consuming the story's whole budget and
 * being indistinguishable from a story that hung.
 */
const AXE_TIMEOUT_MS = Number(process.env.PROBE_AXE_TIMEOUT_MS ?? 20000);

/**
 * `fn(item)`, or a failure result if it has not answered in time.
 *
 * The losing promise cannot be cancelled — Playwright has no abort for an
 * in-flight `evaluate` — so it is left pending and `browser.close()` in the
 * caller's `finally` is what releases it. That is why the pool moves on rather
 * than trying to clean up here.
 */
async function withStoryDeadline(fn, item) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          id: item.id,
          attempt: item.attempt,
          ok: false,
          reason: 'probe-timeout',
          message: `no answer in ${STORY_TIMEOUT_MS}ms — the probe hung on this story`,
          // The reporter walks these on every failure. A synthetic result that
          // omits them crashed it with `Cannot read properties of undefined
          // (reading 'slice')` AFTER the run had finished and passed — the job
          // went red on the summary, not on a story. Empty is also honest: a
          // story that never answered told us nothing to report.
          consoleErrors: [],
          pageErrors: [],
        }),
      STORY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([fn(item), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, n, fn) {
  const queue = [...items];
  const results = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        let result = await withStoryDeadline(fn, item);
        if (isTornContext(result)) {
          process.stdout.write(`  RETRY ${result.id} (storybook reloaded the preview)\n`);
          result = await withStoryDeadline(fn, item);
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

const ids = await fetchStoryIds({ storybookUrl: STORYBOOK_URL, filters: FILTERS, v86: false });
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

const browser = await launchChromium();

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

const shieldNote = (f) => {
  const { entry } = quarantineStatus(f.id);
  return entry && `quarantined until ${entry.expires}: ${entry.reason}`;
};
printFailures(blocking, 'failures', shieldNote);
printFailures(shielded, 'quarantined failures (reported, not blocking)', shieldNote);

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
