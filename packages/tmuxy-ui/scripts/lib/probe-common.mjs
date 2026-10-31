/**
 * The plumbing both story probes share: argument parsing, the story index,
 * the browser, a failing story's artifacts and the failure report.
 *
 * probe-stories.mjs (one fresh page per story) and probe-spikes.mjs (every
 * v86 story on one shared page) differ only in how a story is driven; the
 * rest lives here so the two runners cannot drift apart in what they write or
 * report.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_DIR = resolvePath(SCRIPT_DIR, '..');

/** Where a failing story's screenshot, DOM snapshot and error text go; CI uploads it. */
export const ARTIFACT_DIR = resolvePath(
  PACKAGE_DIR,
  process.env.PROBE_ARTIFACT_DIR || 'probe-artifacts',
);

// axe-core ships with @storybook/addon-a11y, so it is already installed —
// the bundle is injected into each story page rather than added as a dep.
const AXE_PATH = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
/** Impact levels that turn the job red; the rest are reported only. */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

/** `[port] [storyIdSubstring...]`: a leading integer is the Storybook port. */
export function parseProbeArgs(argv) {
  const args = [...argv];
  const port = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 6006;
  return { port, filters: args, storybookUrl: `http://localhost:${port}` };
}

/**
 * Story ids from Storybook's index, by tag and filter. `v86` stories (real
 * tmux in the x86 emulator) are slow, network-dependent and nondeterministic,
 * so they run on probe-spikes.mjs's single shared engine page and nowhere
 * else; `v86: true` selects exactly them, `false` everything else.
 */
/**
 * Which stories a run takes, by the `nightly` tag (docs/TESTS-LAYERS.md § Tiers):
 * `commit` leaves the tagged ones out, `nightly` takes only them, `all`
 * ignores the tag.
 */
const TIERS = {
  commit: (tags) => !tags.includes('nightly'),
  nightly: (tags) => tags.includes('nightly'),
  all: () => true,
};

/** Storybook's index: every entry by id, with its tags. */
export async function fetchStoryIndex(storybookUrl) {
  const res = await fetch(`${storybookUrl}/index.json`);
  if (!res.ok) throw new Error(`storybook /index.json: ${res.status}`);
  return (await res.json()).entries;
}

export async function fetchStoryIds({ storybookUrl, filters, v86, tier = 'all' }) {
  const inTier = TIERS[tier];
  if (!inTier)
    throw new Error(
      `unknown tier ${JSON.stringify(tier)}; one of ${Object.keys(TIERS).join(', ')}`,
    );
  const entries = await fetchStoryIndex(storybookUrl);
  const ids = Object.keys(entries).filter((id) => {
    const entry = entries[id];
    const tags = entry.tags ?? [];
    return entry.type === 'story' && tags.includes('v86') === v86 && inTier(tags);
  });
  if (filters.length === 0) return ids;
  // PROBE_EXACT=1 takes the filters as whole ids: the nightly's re-run of
  // tonight's failures must not also take every story an id is a prefix of
  // (`resize-pane-drag` would take its Vertical and Grid siblings).
  const exact = process.env.PROBE_EXACT === '1';
  return ids.filter((id) => filters.some((f) => (exact ? id === f : id.includes(f))));
}

/**
 * Headless Chromium. The system chromium is always installed in the
 * devcontainer and arm64 has no Playwright-bundled build;
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH overrides.
 */
export function launchChromium() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
  });
}

/**
 * A failing story's screenshot, error text and DOM, named after `label`.
 * Returns the screenshot path for the report.
 */
export async function writeArtifacts(page, label, result) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const base = resolvePath(ARTIFACT_DIR, label.replace(/[^a-z0-9._-]/gi, '_'));
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: false });
  } catch (err) {
    // A crashed renderer has no screenshot to give; the text report still does.
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
    `page errors (${(result.pageErrors ?? []).length}):`,
    ...(result.pageErrors ?? []).map((e) => `  ${e}`),
    '',
    `console errors (${(result.consoleErrors ?? []).length}):`,
    ...(result.consoleErrors ?? []).map((e) => `  ${e}`),
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

/**
 * Print each failure with what a human needs to act on it. `annotate` may
 * return one extra line per failure (the deterministic probe uses it for the
 * quarantine entry that shields the story).
 */
export function printFailures(list, heading, annotate = () => undefined) {
  if (list.length === 0) return;
  console.log(`\n${heading}:`);
  for (const f of list) {
    console.log(`  - ${f.id}${f.attempt > 1 ? ` (attempt ${f.attempt})` : ''}: ${f.reason}`);
    if (f.message) console.log(`      ${f.message.split('\n').join('\n      ')}`);
    if (f.stack) {
      for (const line of f.stack.split('\n').slice(0, 12)) console.log(`      ${line}`);
    }
    for (const e of (f.pageErrors ?? []).slice(0, 2)) {
      console.log(`      pageerror: ${e.split('\n')[0]}`);
    }
    for (const e of (f.consoleErrors ?? []).slice(0, 3)) {
      console.log(`      console: ${e.slice(0, 300)}`);
    }
    if (f.artifact) console.log(`      screenshot: ${f.artifact}`);
    const note = annotate(f);
    if (note) console.log(`      ${note}`);
  }
}

/**
 * axe over the rendered story, once its play function has settled.
 *
 * Scoped to the story root so Storybook's own preview chrome is not blamed on
 * the story, and limited to violations — the passes and incomplete sets are
 * large and nothing reads them.
 */
export async function runAxe(page, storyId, axeTimeoutMs, a11yShield) {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async (timeoutMs) => {
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
        new Promise((resolve) => setTimeout(() => resolve('axe-timeout'), timeoutMs)),
      ]);

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const run = await withDeadline(window.axe.run(root, { resultTypes: ['violations'] }));
        if (run === 'axe-timeout') return 'axe-timeout';
        const inTerminalGrid = (node) =>
          node.target.length === 1 &&
          document.querySelector(node.target[0])?.closest('.terminal-content') != null;
        return run.violations
          .map((v) =>
            v.id === 'color-contrast'
              ? { ...v, nodes: v.nodes.filter((n) => !inTerminalGrid(n)) }
              : v,
          )
          .filter((v) => v.nodes.length > 0)
          .map((v) => ({
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
  }, axeTimeoutMs);
  // A scan that ran out of time reports nothing rather than failing the story:
  // the story itself rendered and asserted fine, and a missing a11y result is
  // not evidence of a violation.
  if (violations === 'axe-timeout') {
    process.stdout.write(`  NOTE  ${storyId}: a11y scan timed out after ${axeTimeoutMs}ms\n`);
    return [];
  }
  return violations.map((v) => ({
    ...v,
    blocking: BLOCKING_IMPACTS.has(v.impact) && !a11yShield(storyId, v.id),
    shield: a11yShield(storyId, v.id),
  }));
}

/**
 * Print post-run summary of failures, slowest stories, non-gating a11y
 * findings, and quarantine hygiene checks.
 */
export function printProbeSummary({ results, ids, quarantine, quarantineStatus }) {
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

  const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 10);
  console.log('\nslowest stories:');
  for (const r of slowest) console.log(`  ${r.seconds.toFixed(1).padStart(6)}s  ${r.id}`);

  // A shielded timeout that the entry does not declare: every run pays the
  // deadline for it until the entry says `failure: "probe-timeout"` and the
  // story is tagged nightly (timeoutsOutOfTier then holds the commit tier to it).
  const undeclared = shielded.filter(
    (r) => r.reason === 'probe-timeout' && quarantineStatus(r.id).entry.failure !== 'probe-timeout',
  );
  if (undeclared.length > 0) {
    console.log(
      '\nquarantined stories that timed out — mark the entry `failure: "probe-timeout"`:',
    );
    for (const r of undeclared) console.log(`  - ${r.id}`);
  }

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
      const why = v.shield
        ? `quarantined until ${v.shield.expires}: ${v.shield.reason}`
        : 'reported';
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

  return blocking;
}

/**
 * The run's verdict per story, for the nightly ledger (`lib/nightly-ledger.mjs`):
 * `{ stories: [{ id, ok, reason, message }] }` at `PROBE_RESULTS_JSON`, when it
 * is set. A story is `ok` only if every attempt it had in this run passed; a
 * quarantined failure counts as `ok`, since quarantine is the decision that it
 * must not be reported.
 */
export function writeProbeResults(results, isShielded = () => false) {
  const path = process.env.PROBE_RESULTS_JSON;
  if (!path) return;
  const byId = new Map();
  for (const r of results) {
    const prev = byId.get(r.id);
    const ok = r.ok || isShielded(r.id);
    if (prev && !prev.ok) continue;
    byId.set(r.id, { id: r.id, ok, reason: r.reason ?? null, message: r.message ?? null });
  }
  writeFileSync(path, JSON.stringify({ stories: [...byId.values()] }, null, 2));
}
