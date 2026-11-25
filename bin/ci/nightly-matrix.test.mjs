import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collect,
  decide,
  failedFiles,
  failureText,
  reportBody,
  stories,
  summary,
} from './nightly-matrix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'nightly-matrix.mjs');
const ROOT = resolve(HERE, '../..');
const FILE = 'tests/a.test.js';
const ID = `${FILE} › Group a pane splits`;

/** A jest `--json` result for one file, its tests given as name → status. */
function jest(tests, { file = FILE, message = '' } = {}) {
  const assertionResults = Object.entries(tests).map(([name, status]) => ({
    fullName: `Group ${name}`,
    status,
    failureMessages: status === 'failed' ? ['\u001b[31mError: no pane\u001b[39m\n    at x'] : [],
  }));
  const bad = message || Object.values(tests).includes('failed');
  return {
    testResults: [
      { name: join(ROOT, file), status: bad ? 'failed' : 'passed', message, assertionResults },
    ],
  };
}

const passes = jest({ 'a pane splits': 'passed' });
const fails = jest({ 'a pane splits': 'failed' });

/** One version's night of the full suite. */
function night(version, first, second, { soft = false } = {}) {
  return collect({
    version,
    soft,
    steps: { 'full-e2e': first === passes ? 'success' : 'failure' },
    sweep: { 'full-e2e': first },
    reconfirm: second ? [second] : [],
  });
}

const flakyOn = (version) => night(version, fails, passes);
const ids = (entries) => entries.map((e) => e.id);

describe('one version of the matrix', () => {
  it('names each test by file and full name, and leaves skipped and todo tests out', () => {
    const data = jest({ one: 'passed', two: 'failed', three: 'pending', four: 'todo' });
    expect(stories(data)).toEqual([
      { id: `${FILE} › Group one`, ok: true },
      { id: `${FILE} › Group two`, ok: false, message: 'Error: no pane' },
    ]);
  });

  it('says what a matcher expected and got, up to the stack', () => {
    const text = [
      'Error: \u001b[2mexpect(\u001b[22mreceived).toBe(expected) // Object.is equality',
      '',
      'Expected: \u001b[32m"%141"\u001b[39m',
      'Received: \u001b[31mnull\u001b[39m',
      '    at Object.toBe (tests/a.test.js:3:5)',
      'after the stack',
    ].join('\n');
    expect(failureText(text)).toBe(
      'Error: expect(received).toBe(expected) // Object.is equality Expected: "%141" Received: null',
    );
    expect(failureText('thrown: "Exceeded timeout of 120000 ms for a test."\n    at x')).toBe(
      'thrown: "Exceeded timeout of 120000 ms for a test."',
    );
    expect(failureText(`Error: ${'x'.repeat(400)}`)).toHaveLength(300);
  });

  it('keeps only the first line of a message that quotes code', () => {
    const text =
      '  ● Test suite failed to run\n\n    SyntaxError\n\n    > 1 | const = ;\n        |       ^';
    expect(failureText(text)).toBe('● Test suite failed to run');
  });

  it('a pass is clean', () => {
    const result = decide({ records: [night('3.4', passes)], expect: ['3.4'] });
    expect(result).toMatchObject({ report: false, fail: false, oneOff: [] });
    expect(result.verdicts.get(ID)).toBe('pass');
  });

  it('failed then passed is a flake, kept for the ledger and not reported', () => {
    const result = decide({ records: [flakyOn('3.4')], expect: ['3.4'] });
    expect(result).toMatchObject({ report: false, fail: false });
    expect(ids(result.oneOff)).toEqual([ID]);
    expect(result.verdicts.get(ID)).toBe('flaky');
  });

  it('failed twice is a defect, reported that night', () => {
    const result = decide({ records: [night('3.4', fails, fails)], expect: ['3.4'] });
    expect(result).toMatchObject({ report: true, fail: true });
    expect(result.confirmed).toEqual([{ id: ID, where: 'tmux 3.4', message: 'Error: no pane' }]);
  });

  it('a file that could not run is one entry, and passing alone makes it a flake', () => {
    const broken = jest({}, { message: '  ● Test suite failed to run\n\nSyntaxError' });
    expect(stories(broken)).toEqual([
      { id: FILE, ok: false, message: '● Test suite failed to run SyntaxError' },
    ]);
    const twice = decide({ records: [night('3.4', broken, broken)] });
    expect(ids(twice.confirmed)).toEqual([FILE]);
    const once = decide({ records: [night('3.4', broken, passes)] });
    expect(once.fail).toBe(false);
    expect(ids(once.oneOff)).toEqual([FILE]);
  });

  it.each([
    ['wrote none', undefined],
    ['names no failure', passes],
  ])('a jest step that failed and %s is a defect', (_, data) => {
    const record = collect({
      version: '3.4',
      steps: { 'full-e2e': 'failure' },
      sweep: { 'full-e2e': data },
    });
    expect(ids(decide({ records: [record] }).confirmed)).toEqual([
      'full-e2e: failed without results',
    ]);
  });

  it('a failed or cancelled step that is not a jest run is a defect; a skipped one is nothing', () => {
    const record = collect({
      version: '3.4',
      steps: { core: 'failure', server: 'cancelled', tui: 'skipped' },
      sweep: { tui: undefined },
    });
    expect(ids(decide({ records: [record] }).confirmed)).toEqual(['core', 'server']);
  });

  it('a job in which no step ran leaves no record', () => {
    expect(collect({ version: '3.4', steps: { core: 'skipped', server: '' } })).toBeNull();
  });

  it('summarises the steps, the defects and the flakes', () => {
    const text = summary(flakyOn('3.4'), { 'full-e2e': 'failure' });
    expect(text).toContain('| full-e2e | failure |');
    expect(text).toContain('0 failed twice, 1 flaky');
    expect(text).toContain(`\`${ID}\` — tmux 3.4 — \`Error: no pane\``);
  });

  it('lists the files to run again, each once', () => {
    const other = jest({}, { file: 'tests/b.test.js', message: 'boom' });
    expect(failedFiles([fails, other, fails, undefined])).toEqual([FILE, 'tests/b.test.js']);
    expect(failedFiles([passes])).toEqual([]);
  });
});

describe('the night over the matrix', () => {
  const quiet = new Map([[ID, 'pass']]);
  const flaked = new Map([[ID, 'flaky']]);

  it('reports a test that is flaky again within seven nights', () => {
    const result = decide({
      records: [flakyOn('3.4')],
      history: [quiet, quiet, quiet, quiet, quiet, flaked],
    });
    expect(result).toMatchObject({ report: true, fail: true, oneOff: [] });
    expect(result.recurring).toMatchObject([{ id: ID, nights: 2 }]);
  });

  it('forgets a flake older than the window', () => {
    const result = decide({
      records: [flakyOn('3.4')],
      history: [quiet, quiet, quiet, quiet, quiet, quiet, flaked],
    });
    expect(result.report).toBe(false);
  });

  it('reports a test that is flaky on two versions the same night', () => {
    const result = decide({ records: [flakyOn('3.4'), flakyOn('3.8'), night('3.5a', passes)] });
    expect(result).toMatchObject({ report: true, fail: true });
    expect(result.several).toMatchObject([{ id: ID, where: 'tmux 3.4 (flaky), 3.8 (flaky)' }]);
  });

  it('a defect on one version outweighs a flake on another', () => {
    const result = decide({ records: [flakyOn('3.4'), night('3.8', fails, fails)] });
    expect(result.confirmed).toMatchObject([{ id: ID, where: 'tmux 3.4 (flaky), 3.8' }]);
    expect(result.several).toEqual([]);
  });

  it('a version that left no file is a defect of that version', () => {
    const result = decide({ records: [night('3.4', passes)], expect: ['3.4', '3.8'] });
    expect(result.fail).toBe(true);
    expect(ids(result.confirmed)).toEqual(['tmux 3.8: the job ended before its suites ran']);
  });

  it('a defect on HEAD is reported without failing the workflow', () => {
    const records = [night('HEAD', fails, fails, { soft: true })];
    const result = decide({ records, expect: ['HEAD'], soft: ['HEAD'] });
    expect(result).toMatchObject({ report: true, fail: false, confirmed: [] });
    expect(ids(result.head)).toEqual([ID]);
    expect(result.verdicts.size).toBe(0);
    expect(reportBody(result, { runUrl: 'u', sha: 's' })).toContain(
      'non-blocking: upstream master',
    );
  });

  it('a flake on HEAD is nothing: not reported, not in the ledger, not a second version', () => {
    const result = decide({
      records: [flakyOn('3.4'), night('HEAD', fails, passes, { soft: true })],
      soft: ['HEAD'],
    });
    expect(result).toMatchObject({ report: false, fail: false, head: [] });
  });

  it('writes the test, the versions, the message and the run into the comment', () => {
    const result = decide({ records: [night('3.4', fails, fails), night('3.8', fails, fails)] });
    const body = reportBody(result, { runUrl: 'https://example.test/runs/1', sha: 'abc' });
    expect(body).toContain(`- \`${ID}\` — tmux 3.4, 3.8 — \`Error: no pane\``);
    expect(body).toContain('Run: https://example.test/runs/1\nCommit: abc');
    expect(body).toContain('When the nightly matrix reports');
  });
});

describe('the command line', () => {
  it('carries a night from the jest files to the comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nightly-matrix-'));
    try {
      const at = (name) => join(dir, name);
      const outputs = at('outputs');
      const run = (...args) =>
        execFileSync(process.execPath, [SCRIPT, ...args], {
          encoding: 'utf8',
          // The refusal at the end is meant to fail; its stack stays out of the log.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GITHUB_OUTPUT: outputs, RUN_URL: 'https://example.test/runs/2' },
        });
      writeFileSync(at('jest.json'), JSON.stringify(fails));
      expect(run('failed-files', at('jest.json'), at('missing.json'))).toBe(`${FILE}\n`);
      expect(run('failed-files', at('missing.json'))).toBe('\n');

      mkdirSync(at('results'));
      run(
        'collect',
        ...['--version', '3.4', '--sweep', `full-e2e=${at('jest.json')}`],
        ...['--reconfirm', at('jest.json'), '--step', 'full-e2e=failure'],
        ...['--out', at('results/3.4.json')],
      );
      run(
        'report',
        ...['--results', at('results'), '--expect', '3.4', '--soft', ''],
        ...['--history', at('history'), '--verdicts-out', at('tonight.json')],
        ...['--body-out', at('body.md')],
      );
      expect(readFileSync(outputs, 'utf8')).toBe(
        'confirmed=true\nflaky=false\nreport=true\nfail=true\n',
      );
      expect(JSON.parse(readFileSync(at('tonight.json'), 'utf8')).verdicts).toEqual({
        [ID]: 'confirmed',
      });
      expect(readFileSync(at('body.md'), 'utf8')).toContain('https://example.test/runs/2');
      expect(() => run('report', '--results', at('results'), '--expect', '')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
