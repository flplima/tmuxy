#!/usr/bin/env node
/**
 * The E2E matrix for one tier, as JSON for `strategy.matrix` in
 * lint-and-tests.yml (docs/TESTS-LAYERS.md § Tiers).
 *
 *   bin/e2e-plan.mjs commit   every suite except the nightly-only files, with
 *                             a jest name pattern that skips [nightly] tests
 *   bin/e2e-plan.mjs commit --with-nightly
 *                             the same, plus one runner for every [nightly]
 *                             test: for a push that changed the E2E suites
 *                             (bin/ci-changes.mjs), so a nightly test it broke
 *                             fails the push rather than the next night
 *   bin/e2e-plan.mjs full     every suite, every test — the tag build
 *
 * Each entry comes out of tests/e2e-suites.json with a `pattern` added: the
 * tier's lookahead followed by the suite's own shard filter, anchored once.
 * Composing the two here keeps the workflow to one `--testNamePattern`.
 *
 * `plan` is exported for its test (packages/tmuxy-ui/scripts/e2e-plan.test.mjs),
 * which also holds the shard filters to the real suites: every describe block
 * of a split file lands in exactly one shard.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TIERS = {
  commit: '(?!.*\\[nightly\\])',
  full: '',
};

/** Every [nightly] test in every file on one runner, as the nightly runs them. */
export const NIGHTLY_TIER = { name: 'nightly-tier', path: 'tests/', pattern: '\\[nightly\\]' };

/**
 * The matrix entries for `tier`, each with its jest name `pattern`; with
 * `withNightly`, the commit tier also gets NIGHTLY_TIER (the full tier has
 * those tests already).
 */
export function plan(suites, tier, { withNightly = false } = {}) {
  const entries = suites
    .filter((suite) => tier === 'full' || suite.tier !== 'nightly')
    .map(({ tier: _tier, filter, ...suite }) => {
      const body = `${TIERS[tier]}${filter ?? ''}`;
      return { ...suite, pattern: body ? `^${body}` : '' };
    });
  return tier === 'commit' && withNightly ? [...entries, NIGHTLY_TIER] : entries;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  const tier = process.argv[2] ?? 'commit';
  if (!(tier in TIERS)) {
    console.error(`unknown tier ${JSON.stringify(tier)}; one of: ${Object.keys(TIERS).join(', ')}`);
    process.exit(2);
  }
  const withNightly = process.argv.slice(3).includes('--with-nightly');
  const file = resolve(import.meta.dirname, '../tests/e2e-suites.json');
  const { suites } = JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(JSON.stringify(plan(suites, tier, { withNightly })));
}
