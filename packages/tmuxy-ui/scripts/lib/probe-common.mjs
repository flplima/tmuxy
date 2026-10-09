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
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_DIR = resolvePath(SCRIPT_DIR, '..');

/** Where a failing story's screenshot, DOM snapshot and error text go; CI uploads it. */
export const ARTIFACT_DIR = resolvePath(
  PACKAGE_DIR,
  process.env.PROBE_ARTIFACT_DIR || 'probe-artifacts',
);

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
export async function fetchStoryIds({ storybookUrl, filters, v86 }) {
  const res = await fetch(`${storybookUrl}/index.json`);
  if (!res.ok) throw new Error(`storybook /index.json: ${res.status}`);
  const json = await res.json();
  const ids = Object.keys(json.entries).filter((id) => {
    const entry = json.entries[id];
    return entry.type === 'story' && (entry.tags ?? []).includes('v86') === v86;
  });
  if (filters.length === 0) return ids;
  return ids.filter((id) => filters.some((f) => id.includes(f)));
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
