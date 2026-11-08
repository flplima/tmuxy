import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './e2e-plan.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { suites } = JSON.parse(readFileSync(join(ROOT, 'tests/e2e-suites.json'), 'utf8'));

describe('the E2E plan', () => {
  it('the commit tier leaves out the nightly-only files and skips [nightly] tests everywhere', () => {
    const commit = plan(suites, 'commit');
    expect(commit.map((s) => s.name)).not.toContain('nvim');
    for (const suite of commit) expect(suite.pattern).toMatch(/^\^\(\?!\.\*\\\[nightly\\\]\)/);
    expect(commit.find((s) => s.name === 'input').pattern).toBe('^(?!.*\\[nightly\\])');
  });

  it('the full tier takes every suite and every test', () => {
    const full = plan(suites, 'full');
    expect(full.map((s) => s.name)).toEqual(suites.map((s) => s.name));
    expect(full.find((s) => s.name === 'input').pattern).toBe('');
  });

  // A push that edited the suites gets the [nightly] tests too, on one more
  // runner, matched as the nightly matches them; the full tier has them all
  // already, so it gets no second copy.
  it('--with-nightly adds one runner for every [nightly] test, on the commit tier only', () => {
    const commit = plan(suites, 'commit');
    const withNightly = plan(suites, 'commit', { withNightly: true });
    expect(withNightly.slice(0, -1)).toEqual(commit);
    const extra = withNightly.at(-1);
    expect(extra.path).toBe('tests/');
    expect(new RegExp(extra.pattern).test('Scenario 24 › creates a session [nightly]')).toBe(true);
    expect(new RegExp(extra.pattern).test('Scenario 7d › a drag selects text')).toBe(false);
    expect(plan(suites, 'full', { withNightly: true })).toEqual(plan(suites, 'full'));
  });

  it('no entry carries the tier field the workflow does not read', () => {
    for (const suite of plan(suites, 'full')) expect(suite).not.toHaveProperty('tier');
  });

  // The one entry on another tmux: the smoke pair the nightly matrix runs on
  // every version, here on the tmux Ubuntu ships, every push.
  it('the tmux 3.4 entry runs the snapshot and alternate-screen suites on that tmux', () => {
    const onOtherTmux = plan(suites, 'commit').filter((s) => s.tmux);
    expect(onOtherTmux.map((s) => s.tmux)).toEqual(['3.4']);
    const path = new RegExp(onOtherTmux[0].path);
    expect(path.test('tests/snapshots/snapshot.test.js')).toBe(true);
    expect(path.test('tests/8-tui-alternate-screen.test.js')).toBe(true);
    expect(path.test('tests/1-input-interaction.test.js')).toBe(false);
  });

  // jest takes an entry's `path` as a regex over the test file's path. A
  // file no entry matches never runs in CI, and its tests guard nothing: the
  // plugin and personalization suites sat out of the matrix that way. A file
  // two entries match runs twice; the tmux 3.4 entry is the one that means to.
  it('every E2E file runs on exactly one entry, besides the other-tmux rerun', () => {
    const entries = plan(suites, 'full').filter((s) => !s.tmux);
    const dirs = ['tests', 'tests/snapshots'];
    const files = dirs.flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => `${dir}/${name}`),
    );
    const runs = Object.fromEntries(
      files.map((file) => [
        file,
        entries.filter((s) => new RegExp(s.path).test(file)).map((s) => s.name),
      ]),
    );
    const wrong = Object.entries(runs).filter(([, names]) => names.length !== 1);
    expect(Object.fromEntries(wrong)).toEqual({});
  });
});
