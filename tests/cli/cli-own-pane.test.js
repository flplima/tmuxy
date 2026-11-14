const { ownPane } = require('./helpers/run-own-pane');

/**
 * `verified_own_pane` (packages/tmuxy-cli/bin/tmuxy/_contract): a caller's
 * claim to run in a pane holds only when that pane's process is one of its
 * ancestors. Run here with the process ancestry stubbed, as `/proc` and
 * `ps` would give it, since the real tree of a test run proves nothing
 * repeatable. The pane `%3`'s process is 4242; `ME` is the checking shell.
 * When the ancestry cannot be read, the claim is refused and the caller is
 * told why, unless the server sets @tmuxy-trust-pane-claims on (the CheerpX
 * guest, which names no parents at all).
 */

const UNPROVEN = /cannot prove this runs in %3/;

describe('verified_own_pane', () => {
  test('from /proc: an ancestor holds, a stranger does not, an unreadable parent proves nothing', () => {
    expect(ownPane({ parents: '"$ME") echo 100 ;; 100) echo 4242 ;;' })).toEqual({
      claim: '%3',
      said: '',
    });
    expect(ownPane({ parents: '"$ME") echo 100 ;; 100) echo 1 ;;' })).toEqual({
      claim: '',
      said: '',
    });
    const unreadable = ownPane({ parents: '"$ME") echo 100 ;;' });
    expect(unreadable.claim).toBe('');
    expect(unreadable.said).toMatch(UNPROVEN);
  });

  test('from ps: an ancestor holds, and a table that leaves this process out proves nothing', () => {
    expect(ownPane({ table: '$ME 100\\n100 4242\\n4242 1\\n' }).claim).toBe('%3');
    expect(ownPane({ table: '$ME 100\\n100 1\\n' })).toEqual({ claim: '', said: '' });
    const silent = ownPane({ table: '' });
    expect(silent.claim).toBe('');
    expect(silent.said).toMatch(UNPROVEN);
    const broken = ownPane({ table: '$ME 100\\n' });
    expect(broken.claim).toBe('');
    expect(broken.said).toMatch(UNPROVEN);
  });

  test('an unproven claim stands only where the server trusts claims, and a disproven one never', () => {
    expect(ownPane({ table: '', trust: true })).toEqual({ claim: '%3', said: '' });
    expect(ownPane({ parents: '"$ME") echo 100 ;;', trust: true }).claim).toBe('%3');
    expect(ownPane({ parents: '"$ME") echo 100 ;; 100) echo 1 ;;', trust: true }).claim).toBe('');
  });
});
