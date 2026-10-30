import { describe, expect, it } from 'vitest';
import { ledger, mergeResults, reportBody, verdicts } from './lib/nightly-ledger.mjs';

const results = (pairs) => ({ stories: pairs.map(([id, ok]) => ({ id, ok })) });
const night = (pairs) => new Map(pairs);

describe('mergeResults', () => {
  it('fails a story that failed in any of the files', () => {
    const merged = mergeResults([
      results([
        ['a', true],
        ['b', false],
      ]),
      results([
        ['a', false],
        ['c', true],
      ]),
    ]);
    expect([...merged]).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });

  it('takes a missing file as no stories', () => {
    expect(mergeResults([undefined, results([['a', true]])]).get('a')).toBe(true);
  });
});

describe('verdicts', () => {
  const sweep = night([
    ['ok', true],
    ['flake', false],
    ['broken', false],
    ['unchecked', false],
  ]);
  const reconfirm = night([
    ['flake', true],
    ['broken', false],
  ]);

  it('passes, flakes and confirms by the fresh runner', () => {
    expect(Object.fromEntries(verdicts(sweep, reconfirm))).toEqual({
      ok: 'pass',
      flake: 'flaky',
      broken: 'confirmed',
      // No second opinion is not a reason to look away.
      unchecked: 'confirmed',
    });
  });
});

describe('ledger', () => {
  it('reports a confirmed failure the night it happens', () => {
    const result = ledger([night([['broken', 'confirmed']])]);
    expect(result.report).toBe(true);
    expect(result.confirmed).toEqual(['broken']);
  });

  it('records a one-night flake without reporting it', () => {
    const result = ledger([night([['theme', 'flaky']]), night([['theme', 'pass']])]);
    expect(result.report).toBe(false);
    expect(result.flakyTonight).toEqual(['theme']);
  });

  it('reports a story that flakes again within the window', () => {
    const result = ledger([
      night([['theme', 'flaky']]),
      night([['theme', 'pass']]),
      night([['theme', 'flaky']]),
    ]);
    expect(result.report).toBe(true);
    expect(result.recurring).toEqual([{ id: 'theme', nights: 2 }]);
  });

  it('forgets a flake older than the window', () => {
    const nights = [night([['theme', 'flaky']])];
    for (let i = 0; i < 7; i++) nights.push(night([['theme', 'pass']]));
    nights.push(night([['theme', 'flaky']]));
    expect(ledger(nights).report).toBe(false);
  });

  it('is quiet on a clean night', () => {
    expect(ledger([night([['a', 'pass']])]).report).toBe(false);
  });
});

describe('reportBody', () => {
  it('names each story, why it failed, and the run', () => {
    const body = reportBody(
      {
        confirmed: ['broken'],
        recurring: [{ id: 'theme', nights: 3 }],
        nightsKnown: 7,
      },
      {
        runUrl: 'https://run/1',
        sha: 'abc',
        failures: new Map([['broken', 'expected 1 to be 2']]),
      },
    );
    expect(body).toContain('`broken` — expected 1 to be 2');
    expect(body).toContain('`theme` — 3 nights');
    expect(body).toContain('Run: https://run/1');
    expect(body).toContain('Commit: abc');
  });
});
