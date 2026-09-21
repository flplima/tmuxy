import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { a11yShield, loadQuarantine, quarantineStatus } from './probe-quarantine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const list = (name) => loadQuarantine(resolve(HERE, name));

// A shielded failure is the difference between a red job and a green one, so
// the dates are what these assert — not just that an id is present.
const quarantine = {
  byId: new Map([
    ['live', { id: 'live', reason: 'why', expires: '2099-01-01' }],
    ['stale', { id: 'stale', reason: 'why', expires: '2020-01-01' }],
  ]),
  a11y: [
    { id: '*', rule: 'color-contrast', expires: '2099-01-01' },
    { id: 'one-story', rule: 'nested-interactive', expires: '2099-01-01' },
    { id: '*', rule: 'aria-hidden-focus', expires: '2020-01-01' },
  ],
  today: '2026-09-21',
};

describe('quarantine policy', () => {
  it('shields a listed story until its expiry date', () => {
    expect(quarantineStatus(quarantine, 'live').shielded).toBe(true);
  });

  it('stops shielding on and after the expiry date, so the job goes red again', () => {
    const status = quarantineStatus(quarantine, 'stale');
    expect(status.shielded).toBe(false);
    expect(status.expired).toBe(true);
  });

  it('does not shield a story that is not listed', () => {
    expect(quarantineStatus(quarantine, 'unlisted').shielded).toBe(false);
  });

  it('shields an a11y rule globally, per story, and never past its expiry', () => {
    expect(a11yShield(quarantine, 'any-story', 'color-contrast')).toBeTruthy();
    expect(a11yShield(quarantine, 'one-story', 'nested-interactive')).toBeTruthy();
    expect(a11yShield(quarantine, 'other-story', 'nested-interactive')).toBeUndefined();
    expect(a11yShield(quarantine, 'any-story', 'aria-hidden-focus')).toBeUndefined();
  });
});

// loadQuarantine rejects a bad list by exiting the process, so the committed
// lists are checked here instead — where a malformed one is a test failure
// rather than a probe that dies mid-run in CI.
describe('the committed quarantine lists', () => {
  it.each(['probe-quarantine.json', 'probe-quarantine-v86.json'])(
    '%s satisfies the policy',
    (name) => {
      const loaded = list(name);
      expect(loaded.byId.size).toBeLessThanOrEqual(loaded.max);
      for (const entry of loaded.byId.values()) {
        expect(entry.reason.trim()).not.toBe('');
        expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    },
  );
});
