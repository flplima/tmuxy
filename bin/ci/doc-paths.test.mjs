import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanToken,
  isKnownJob,
  isPathToken,
  jobCatalog,
  jobTokens,
  resolveDocPath,
} from './doc-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { suites } = JSON.parse(readFileSync(join(ROOT, 'tests/e2e-suites.json'), 'utf8'));

const REPO = new Set([
  'docs/TESTS.md',
  'packages/tmuxy-core/src/host/prepare.rs',
  'packages/tmuxy-core/src/control_mode/state/pane_output.rs',
  'packages/tmuxy-ui/src/components/menus/SpecMenu.tsx',
  'packages/tmuxy-ui/src/domain/commands.ts',
  'packages/tmuxy-ui/scripts/probe-stories.mjs',
  'packages/tmuxy-cli/bin/tmuxy/_pane',
  'packages/tmuxy-cli/bin/tmuxy/_lib/common.sh',
]);
const exists = (p) => REPO.has(p);

describe('a backticked path in a doc', () => {
  it('is a token with a slash and a source extension, and no placeholder', () => {
    expect(isPathToken('tmuxy-core/src/host/prepare.rs')).toBe(true);
    expect(isPathToken('bin/ci/doc-paths.mjs')).toBe(true);
    for (const notAPath of [
      'host/command', // no extension: a module, a directory
      'tmuxy pane send', // a command
      'fixtures/gen/<scenario>.json',
      'src/**/*.stories.tsx',
      '~/.config/tmuxy/tmux.conf',
      '/tmp/tmuxy-server.log',
      '$HOME/x/y.json',
      'https://x.dev/a/b.md',
      '../other/file.rs',
    ]) {
      expect(isPathToken(notAPath), notAPath).toBe(false);
    }
  });

  it('loses the punctuation and anchor a sentence adds', () => {
    expect(cleanToken(' docs/TESTS.md#suites). ')).toBe('docs/TESTS.md');
    expect(cleanToken('./bin/x.mjs:')).toBe('bin/x.mjs');
  });

  it('resolves from the root, a package, or the source dirs the docs leave out', () => {
    expect(resolveDocPath('docs/TESTS.md', exists)).toBe('docs/TESTS.md');
    expect(resolveDocPath('tmuxy-core/src/host/prepare.rs', exists)).toBe(
      'packages/tmuxy-core/src/host/prepare.rs',
    );
    expect(resolveDocPath('control_mode/state/pane_output.rs', exists)).toBe(
      'packages/tmuxy-core/src/control_mode/state/pane_output.rs',
    );
    expect(resolveDocPath('components/menus/SpecMenu.tsx', exists)).toBe(
      'packages/tmuxy-ui/src/components/menus/SpecMenu.tsx',
    );
    expect(resolveDocPath('scripts/probe-stories.mjs', exists)).toBe(
      'packages/tmuxy-ui/scripts/probe-stories.mjs',
    );
    expect(resolveDocPath('_lib/common.sh', exists)).toBe(
      'packages/tmuxy-cli/bin/tmuxy/_lib/common.sh',
    );
  });

  it('resolves nowhere when the file moved', () => {
    expect(resolveDocPath('menus/SpecMenu.tsx', exists)).toBeNull();
    expect(resolveDocPath('tmuxy-ui/src/components/SpecMenu.tsx', exists)).toBeNull();
  });
});

describe('a CI job named in a triage doc', () => {
  const catalog = jobCatalog(ROOT, suites);

  it('is a workflow name, a job key, a shard of the E2E matrix or a probe shard', () => {
    expect(catalog.workflows.get('lint and tests').jobs.has('e2e')).toBe(true);
    for (const known of [
      'lint and tests',
      'lint-and-tests.yml',
      'ci',
      'changes',
      'e2e (layout-tree)',
      'e2e (nightly-tier)',
      'e2e (<shard>)',
      'storybook-probe (1/2)',
      'nightly v86 sweep / deterministic',
      'nightly perf / core-bench',
    ]) {
      expect(isKnownJob(known, catalog), known).toBe(true);
    }
  });

  it('is not an old shard, a renamed workflow or a job of another workflow', () => {
    for (const stale of [
      'e2e (2-layout-a)',
      'perf measurements',
      'timing',
      'v86 / deterministic',
      'lint and tests / sweep',
      'storybook-probe (one)',
    ]) {
      expect(isKnownJob(stale, catalog), stale).toBe(false);
    }
  });

  it('is read from a job column and from a shaped token anywhere', () => {
    const doc = [
      '| Workflow job | Local command |',
      '| --- | --- |',
      '| `lint` | `bin/lint-gate check` (`policy`) |',
      '| nightly `nightly perf / soak` | `npm run perf:soak` |',
      '',
      'Every `e2e (tmux-3.4)` run has a `desktop` job beside it.',
    ].join('\n');
    expect(jobTokens(doc)).toEqual([
      [3, 'lint'],
      [4, 'nightly perf / soak'],
      [6, 'e2e (tmux-3.4)'],
    ]);
  });
});
