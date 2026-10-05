const { failedTests, classify, tally } = require('../../bin/flake-ledger');

describe('flake ledger', () => {
  test('reads the failed test names out of a GitHub job log', () => {
    const log = [
      '2026-10-05T11:44:23.1Z     ✓ passes (12 ms)',
      '2026-10-05T11:44:23.1Z     \u001b[31m✕\u001b[39m a question asked of the pane beside you (77992 ms)',
      '2026-10-05T11:44:24.1Z     ✕ no timing on this one',
      '2026-10-05T11:44:25.1Z     ✕ a question asked of the pane beside you (12 ms)',
      '2026-10-05T11:44:26.1Z     ✓ ctrl+0 shows every tab; click, +, ✕ and drag act on the strip (8059 ms)',
    ].join('\n');
    expect(failedTests(log)).toEqual([
      'a question asked of the pane beside you',
      'no timing on this one',
    ]);
  });

  test('a job that failed and passed on a later attempt is flaky; one never retried is a failure', () => {
    const job = (name, conclusion) => ({ name, conclusion });
    const { flaky, failed } = classify([
      [job('e2e (13)', 'failure'), job('lint', 'cancelled'), job('e2e (2)', 'failure')],
      [job('e2e (13)', 'success'), job('lint', 'success'), job('e2e (2)', 'failure')],
    ]);
    expect(flaky.map((f) => [f.job.name, f.attempt])).toEqual([['e2e (13)', 1]]);
    expect(failed.map((f) => [f.job.name, f.attempt])).toEqual([
      ['e2e (2)', 1],
      ['e2e (2)', 2],
    ]);
  });

  test('counts by job and test, most frequent first, with a link per occurrence', () => {
    const rows = tally([
      { job: 'e2e (13)', test: 'a', run: 'r1' },
      { job: 'e2e (14)', test: 'b', run: 'r2' },
      { job: 'e2e (13)', test: 'a', run: 'r3' },
    ]);
    expect(rows).toEqual([
      { job: 'e2e (13)', test: 'a', count: 2, runs: ['r1', 'r3'] },
      { job: 'e2e (14)', test: 'b', count: 1, runs: ['r2'] },
    ]);
  });
});
