import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A workflow's path filter or cache key names the crates a job builds from,
 * and only a list of globs can go there. Each one is held here against the
 * crate graph (`crate-graph.json`, written from `cargo metadata`): a crate
 * that joins a guest's build without joining its key reuses a stale guest.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const GRAPH = JSON.parse(read('bin/ci/crate-graph.json')).crates;

/** Every crate directory `crates` are built from, as `<dir>/**` globs. */
function crateGlobs(...crates) {
  return [...new Set(crates.flatMap((name) => GRAPH[name]))].map((dir) => `${dir}/**`);
}

/** The globs a `hashFiles(…)` on the line naming `key` hashes. */
function hashedGlobs(file, key) {
  const line = read(file)
    .split('\n')
    .find((l) => l.includes(`-${key}-\${{ hashFiles(`));
  expect(line, `${file}: no ${key} cache key`).toBeDefined();
  return [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The `paths:` filter of a workflow's `push` trigger. */
function pushPaths(file) {
  const lines = read(file).split('\n');
  const start = lines.findIndex((l) => /^\s+paths:\s*$/.test(l));
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+- '([^']+)'/.exec(line);
    if (item) globs.push(item[1]);
    else if (!/^\s+#/.test(line)) break;
  }
  return globs;
}

describe('what a workflow says a job is built from is the crate graph', () => {
  it('the v86 guest cache key hashes every crate of tmuxy-verbs', () => {
    expect(hashedGlobs('.github/actions/v86-guest/action.yml', 'v86-assets')).toEqual(
      expect.arrayContaining(crateGlobs('tmuxy-verbs')),
    );
  });

  it('the CheerpX image cache key hashes every crate of tmuxy-verbs and tmuxy-pty', () => {
    expect(hashedGlobs('.github/workflows/deploy-demo.yml', 'cheerpx-image')).toEqual(
      expect.arrayContaining(crateGlobs('tmuxy-verbs', 'tmuxy-pty')),
    );
  });

  it('the demo deploys on a change to any crate it runs', () => {
    expect(pushPaths('.github/workflows/deploy-demo.yml')).toEqual(
      expect.arrayContaining(crateGlobs('tmuxy-wasm', 'tmuxy-verbs', 'tmuxy-pty')),
    );
  });
});
