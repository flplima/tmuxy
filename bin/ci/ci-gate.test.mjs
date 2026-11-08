import { describe, expect, it } from 'vitest';
import { verdict } from './ci-gate.mjs';

describe('the ci gate', () => {
  it('passes a run whose jobs all passed or were skipped by the changes filter', () => {
    expect(
      verdict({
        lint: { result: 'success' },
        desktop: { result: 'skipped' },
        e2e: { result: 'success' },
      }),
    ).toEqual([]);
  });

  it('names every job that failed or was cancelled', () => {
    expect(
      verdict({
        lint: { result: 'success' },
        e2e: { result: 'failure' },
        desktop: { result: 'cancelled' },
      }),
    ).toEqual(['e2e: failure', 'desktop: cancelled']);
  });
});
