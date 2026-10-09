#!/usr/bin/env node
/**
 * The E2E matrix for one tier, as JSON for `strategy.matrix` in
 * lint-and-tests.yml (docs/TESTS.md § Tiers).
 *
 *   bin/e2e-plan.mjs commit   every suite except the nightly-only files, with
 *                             a jest name pattern that skips [nightly] tests
 *   bin/e2e-plan.mjs full     every suite, every test — the tag build
 *
 * Each entry comes out of tests/e2e-suites.json with a `pattern` added: the
 * tier's lookahead followed by the suite's own shard filter, anchored once.
 * Composing the two here keeps the workflow to one `--testNamePattern`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TIERS = {
  commit: '(?!.*\\[nightly\\])',
  full: '',
};

const tier = process.argv[2] ?? 'commit';
if (!(tier in TIERS)) {
  console.error(`unknown tier ${JSON.stringify(tier)}; one of: ${Object.keys(TIERS).join(', ')}`);
  process.exit(2);
}

const file = resolve(import.meta.dirname, '../tests/e2e-suites.json');
const { suites } = JSON.parse(readFileSync(file, 'utf8'));

const plan = suites
  .filter((suite) => tier === 'full' || suite.tier !== 'nightly')
  .map(({ tier: _tier, filter, ...suite }) => {
    const body = `${TIERS[tier]}${filter ?? ''}`;
    return { ...suite, pattern: body ? `^${body}` : '' };
  });

process.stdout.write(JSON.stringify(plan));
