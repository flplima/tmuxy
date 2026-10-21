import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The repo's one vitest root is this package; bin/ has no runner of its own.
import { plan } from '../../../bin/e2e-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { suites } = JSON.parse(readFileSync(join(ROOT, 'tests/e2e-suites.json'), 'utf8'));

/** The test files a suite entry's `path` names: a file, or every file under a prefix. */
function filesOf(suitePath) {
  const full = join(ROOT, suitePath);
  if (suitePath.endsWith('.test.js')) return [full];
  const dir = suitePath.endsWith('/') ? full : dirname(full);
  const prefix = suitePath.endsWith('/') ? '' : basename(full);
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.test.js'))
    .map((name) => join(dir, name));
}

/** The top-level `describe('…'` titles in a file: what a shard filter is matched against. */
function describeTitles(file) {
  return [...readFileSync(file, 'utf8').matchAll(/^describe\(\s*(['"`])(.+?)\1/gm)].map(
    (m) => m[2],
  );
}

describe('the E2E plan', () => {
  it('the commit tier leaves out the nightly-only files and skips [nightly] tests everywhere', () => {
    const commit = plan(suites, 'commit');
    expect(commit.map((s) => s.name)).not.toContain('6-nvim');
    for (const suite of commit) expect(suite.pattern).toMatch(/^\^\(\?!\.\*\\\[nightly\\\]\)/);
    expect(commit.find((s) => s.name === '1-input').pattern).toBe('^(?!.*\\[nightly\\])');
  });

  it('the full tier takes every suite and every test', () => {
    const full = plan(suites, 'full');
    expect(full.map((s) => s.name)).toEqual(suites.map((s) => s.name));
    expect(full.find((s) => s.name === '1-input').pattern).toBe('');
    expect(full.find((s) => s.name === '2-layout-a').pattern).toMatch(/^\^Scenario /);
  });

  it('no entry carries the tier field the workflow does not read', () => {
    for (const suite of plan(suites, 'full')) expect(suite).not.toHaveProperty('tier');
  });

  // The shard filters are regexes someone wrote by hand against the scenario
  // numbers of the day. A new "Scenario 6n" has to land in exactly one of the
  // two halves of its file, or it runs twice — or, the worse case, never.
  it('every describe block of a split file lands in exactly one shard', () => {
    const full = plan(suites, 'full');
    const byPath = new Map();
    for (const suite of full) {
      if (!byPath.has(suite.path)) byPath.set(suite.path, []);
      byPath.get(suite.path).push(suite);
    }
    for (const [suitePath, shards] of byPath) {
      if (shards.length < 2) continue;
      for (const file of filesOf(suitePath)) {
        for (const title of describeTitles(file)) {
          // jest matches the pattern against "<describe> <test>", so a title
          // with any test name after it stands for every test in the block.
          const name = `${title} some test`;
          const matching = shards.filter((s) => new RegExp(s.pattern).test(name));
          expect(
            matching.map((s) => s.name),
            `${basename(file)} › "${title}" should run in one shard`,
          ).toHaveLength(1);
        }
      }
    }
  });
});
