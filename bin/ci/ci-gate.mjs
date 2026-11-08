#!/usr/bin/env node
/**
 * The verdict of the `ci` job in lint-and-tests.yml, the one check the
 * ruleset on main requires: every job it waited for passed, or was skipped
 * by the `changes` filter. A job that failed or was cancelled fails the run.
 *
 *   RESULTS='{"lint":{"result":"success"},…}' bin/ci/ci-gate.mjs
 *
 * RESULTS is the workflow's `toJSON(needs)`. `verdict` is exported for its
 * test (ci-gate.test.mjs, beside it).
 */

const PASSING = new Set(['success', 'skipped']);

/** The jobs that did not pass, by name; empty when the run is green. */
export function verdict(needs) {
  return Object.entries(needs)
    .filter(([, job]) => !PASSING.has(job.result))
    .map(([name, job]) => `${name}: ${job.result}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const failed = verdict(JSON.parse(process.env.RESULTS ?? '{}'));
  for (const line of failed) console.log(`::error title=ci::${line}`);
  if (failed.length === 0) console.log('every job passed or was skipped');
  process.exit(failed.length === 0 ? 0 : 1);
}
