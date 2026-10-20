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
 *   PROBE_TIER          `commit` leaves out stories tagged `nightly`,
 *                       `nightly` takes only them, `all` (default) ignores
 *                       the tag. docs/TESTS-LAYERS.md § Tiers.
 *   PROBE_SHARD         `i/n` runs the i-th of n equal slices of the story
 *                       list (1-based), so the probe can be spread across
 *                       runners; every story lands in exactly one slice.
 *   PROBE_REPEAT        run each selected story N times (default 1) and fail
 *                       if ANY attempt fails — how a story is shown to be
 *                       deterministic rather than lucky.
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH  browser to drive.
 *
 * Accessibility: every story is also scanned with axe-core once its play
 * function has settled. `critical` and `serious` violations fail the job;
 * `moderate` and `minor` are printed and do not gate — a gate nobody can get
 * green gets switched off, which is worse than no gate. One scope rule:
 * `color-contrast` is not applied inside a terminal grid (`.terminal-content`):
 * its colours are the program's output in the theme's ANSI palette, not the
 * app's chrome. Every other rule still scans the grid.
 *
 * Quarantine: scripts/probe-quarantine.json lists stories whose failures are
 * reported but do not fail the job, and a11y rules that are reported but do
 * not gate, each with an expiry date. See the `_policy` block in that file.
 */

import { resolve as resolvePath } from 'node:path';
import {
  a11yShield as shieldFor,
  loadQuarantine,
  quarantineStatus as statusFor,
  timeoutsOutOfTier,
} from './probe-quarantine.mjs';
import {
  ARTIFACT_DIR,
  SCRIPT_DIR,
  fetchStoryIds,
  fetchStoryIndex,
  launchChromium,
  parseProbeArgs,
  printProbeSummary,
  runAxe,
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

const quarantine = loadQuarantine(resolvePath(SCRIPT_DIR, 'probe-quarantine.json'));
const quarantineStatus = (id) => statusFor(quarantine, id);
const a11yShield = (storyId, rule) => shieldFor(quarantine, storyId, rule);

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
          for (const reason of [
            'storyThrewException',
            'storyErrored',
            'playFunctionThrewException',
            'storyMissing',
          ]) {
            const prev = channel.last?.(reason);
            if (prev && prev.length > 0) {
              failure(reason)(prev[0]);
              return;
            }
          }
          if (channel.last?.('storyRendered')?.length) {
            success();
          }
        }),
      PER_STORY_TIMEOUT_MS,
    );

    result = { id, attempt, ...outcome, consoleErrors, pageErrors };
    // Only a story that rendered has a DOM worth scanning; a failed one is
    // already being reported and its axe result would just be noise.
    if (result.ok && RUN_A11Y) {
      try {
        result.a11y = await runAxe(page, id, AXE_TIMEOUT_MS, a11yShield);
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
        const started = Date.now();
        let result = await withStoryDeadline(fn, item);
        if (isTornContext(result)) {
          process.stdout.write(`  RETRY ${result.id} (storybook reloaded the preview)\n`);
          result = await withStoryDeadline(fn, item);
        }
        result.seconds = (Date.now() - started) / 1000;
        results.push(result);
        const status = quarantineStatus(result.id);
        const tag = result.ok ? 'PASS' : status.shielded ? 'FLAKY' : 'FAIL';
        const suffix = result.reason ? ` (${result.reason})` : '';
        // The duration is what bin/ci-timing.mjs reads back out of the log.
        process.stdout.write(`  ${tag}  ${result.id}${suffix} (${result.seconds.toFixed(1)}s)\n`);
      }
    }),
  );
  return results;
}

const TIER = process.env.PROBE_TIER || 'all';
const allIds = await fetchStoryIds({
  storybookUrl: STORYBOOK_URL,
  filters: FILTERS,
  v86: false,
  tier: TIER,
});
if (TIER === 'commit') {
  const index = await fetchStoryIndex(STORYBOOK_URL);
  const stuck = timeoutsOutOfTier(quarantine, (id) => index[id]?.tags);
  if (stuck.length > 0) {
    console.error('quarantined stories that time out must carry the `nightly` tag:');
    for (const e of stuck) console.error(`  - ${e.id}`);
    process.exit(2);
  }
}
// Stride, not contiguous blocks: the index lists a file's stories together,
// and a file's heavy stories (whole-app boots) would otherwise all land
// in the same slice.
const shard = (process.env.PROBE_SHARD || '1/1').match(/^(\d+)\/(\d+)$/);
if (!shard || Number(shard[1]) < 1 || Number(shard[1]) > Number(shard[2])) {
  console.error(
    `PROBE_SHARD must be i/n with 1 <= i <= n, got ${JSON.stringify(process.env.PROBE_SHARD)}`,
  );
  process.exit(2);
}
const ids = allIds.filter((_, k) => k % Number(shard[2]) === Number(shard[1]) - 1);
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

const blocking = printProbeSummary({ results, ids, quarantine, quarantineStatus });

process.exit(blocking.length === 0 ? 0 : 1);
