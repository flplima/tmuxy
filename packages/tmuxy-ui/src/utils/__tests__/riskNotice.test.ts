import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeRiskNotice, riskNoticeAcknowledged } from '../riskNotice';

/** A `localStorage` of the test's own, so nothing leaks between tests or runtimes. */
function stubStorage(denied = false): void {
  const items = new Map<string, string>();
  const refuse = () => {
    throw new Error('denied');
  };
  vi.stubGlobal('localStorage', {
    getItem: denied ? refuse : (key: string) => items.get(key) ?? null,
    setItem: denied ? refuse : (key: string, value: string) => void items.set(key, value),
  });
}

describe('riskNotice', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is unacknowledged until the user says "don\'t show this again"', () => {
    stubStorage();
    expect(riskNoticeAcknowledged()).toBe(false);
    acknowledgeRiskNotice();
    expect(riskNoticeAcknowledged()).toBe(true);
  });

  it('asks again when there is no storage to remember in', () => {
    stubStorage(true);
    expect(() => acknowledgeRiskNotice()).not.toThrow();
    expect(riskNoticeAcknowledged()).toBe(false);
  });
});
