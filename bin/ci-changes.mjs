#!/usr/bin/env node
/**
 * Which of the gated CI jobs a push can skip, from the files it changed.
 *
 * The desktop job (a Tauri build, Xvfb, two suites) and the v86 probe (a wasm
 * build and a guest image) are the two longest jobs of lint-and-tests.yml,
 * and a push that touched only the E2E suites, the demo site or a workflow
 * ran both for nothing. `audit` is the other way round: it was red for
 * advisories that no push had anything to do with, so it now runs only when
 * a lockfile moved (the Sunday sweep covers the rest of the week). And the
 * [nightly] E2E tier, which a push skips, runs on one more runner when the
 * push edited the suites it lives in.
 *
 * The rules are data here, so they can be read and tested
 * (packages/tmuxy-ui/scripts/ci-changes.test.mjs) rather than buried in a
 * workflow's shell step. Two shapes:
 *
 *   SKIPPABLE — the job runs unless EVERY changed file is irrelevant to it.
 *               The safe direction: a file no pattern names runs the job.
 *   TRIGGERED — the job runs only when SOME changed file is one it covers.
 *
 * A base the checkout cannot reach (a force-push, the first push of a branch,
 * a tag) runs everything: the filter only ever saves time, never coverage.
 *
 * Usage: node bin/ci-changes.mjs <base-sha>
 *   prints `name=true|false` lines for $GITHUB_OUTPUT, a summary on stderr.
 */

import { execFileSync } from 'node:child_process';

/** What no gated job reads: prose, agent instructions, CI plumbing of its own. */
const PROSE = [/^docs\//, /\.md$/, /^\.agents\//, /^\.claude\//];
const TOOLING = [
  /^bin\/.*\.mjs$/,
  /^(\.prettierrc|\.prettierignore|eslint\.config\.mjs|\.gitignore)$/,
  // Another workflow, or a dependabot/issue/PR template; this workflow and
  // the composite actions it calls are NOT here, since they shape the jobs.
  /^\.github\/(?!workflows\/lint-and-tests\.yml$|actions\/)/,
];

export const SKIPPABLE = {
  // The Tauri app links tmuxy-core and tmuxy-server and bundles the UI, the
  // CLI (bin/tmuxy-cli, bin/tmuxy/*) and the shipped tmux confs
  // (packages/tmuxy-core/assets, include_str!'d by tmuxy-core). Its suites are
  // tests/tauri and tests/smoke, on tests/helpers.
  desktop: [
    ...PROSE,
    ...TOOLING,
    /^tests\/(?!tauri\/|smoke\/|helpers\/)/,
    /^packages\/tmuxy-(demo|wasm|group)\//,
    /^perf\//,
    /^packages\/tmuxy-ui\/(src\/stories\/|scripts\/|\.storybook\/|eslint-rules\/)/,
  ],
  // The v86 probe runs Storybook over tmuxy-wasm (on tmuxy-core) and a guest
  // image baked from tmuxy-group, the CLI and the shipped confs.
  v86: [...PROSE, ...TOOLING, /^tests\//, /^packages\/tmuxy-(demo|server|tauri-app)\//, /^perf\//],
};

export const TRIGGERED = {
  // `cargo test` on a Mac: only the code with a macOS branch.
  'macos-rust': [
    /^packages\/tmuxy-tauri-app\//,
    /^packages\/tmuxy-core\/src\/control_mode\/connection\.rs$/,
    /^bin\//,
    /^Cargo\.(toml|lock)$/,
    /^\.github\/workflows\/lint-and-tests\.yml$/,
  ],
  audit: [
    /^package-lock\.json$/,
    /^Cargo\.lock$/,
    /^\.cargo\/audit\.toml$/,
    /^\.github\/workflows\/lint-and-tests\.yml$/,
  ],
  // The [nightly] E2E tier on one more runner (bin/e2e-plan.mjs
  // --with-nightly): a push that edits the web suites or their helpers is
  // the one most likely to break a nightly test, and otherwise the next
  // night's run is the first to say so.
  'nightly-e2e': [
    /^tests\/(?!cli\/|tauri\/)/,
    /^bin\/e2e-plan\.mjs$/,
    /^\.github\/workflows\/lint-and-tests\.yml$/,
  ],
};

const SELF = 'bin/ci-changes.mjs';

/**
 * The decision for each job: `true` to run it. `files` is the changed
 * paths, or null when they cannot be known — then everything runs, and so it
 * does when this file itself changed, since a rule is proven by the jobs it
 * would have skipped.
 */
export function decide(files) {
  const all = files === null || files.includes(SELF);
  const matches = (patterns, file) => patterns.some((p) => p.test(file));
  const out = {};
  for (const [job, irrelevant] of Object.entries(SKIPPABLE)) {
    out[job] = all || files.some((f) => !matches(irrelevant, f));
  }
  for (const [job, covered] of Object.entries(TRIGGERED)) {
    out[job] = all || files.some((f) => matches(covered, f));
  }
  return out;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The changed files between `base` and HEAD, or null when `base` cannot be had. */
function changedSince(base) {
  if (!base || /^0+$/.test(base)) return null;
  try {
    git('cat-file', '-e', `${base}^{commit}`);
  } catch {
    // A shallow checkout: fetch just that commit. A sha GitHub no longer has
    // (force-pushed away) fails here, and that is the "run everything" case.
    try {
      git('fetch', '--quiet', '--depth=1', 'origin', base);
    } catch {
      return null;
    }
  }
  try {
    return git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const base = process.argv[2];
  const files = changedSince(base);
  const decision = decide(files);
  for (const [job, run] of Object.entries(decision)) console.log(`${job}=${run}`);
  console.error(
    files === null
      ? `base ${base || '(none)'} not reachable: every job runs`
      : `${files.length} changed file(s) since ${base.slice(0, 8)}: ${JSON.stringify(decision)}`,
  );
}
