/**
 * `tmuxy cleanup` — reaping shells left hanging by a pane that died while its
 * shell was still starting up.
 *
 * The risk in this command is entirely in *which* processes it selects: it
 * sends SIGKILL, so a shell someone is using must never match. These tests
 * drive the real script with a fake `ps` ahead of it on PATH, in --dry-run, so
 * the selection is asserted without a signal being sent to anything. See
 * `helpers/run-reaper.js`.
 */

const { runReaper } = require('./helpers/run-reaper');

describe('tmuxy cleanup (reap-orphan-shells)', () => {
  test('selects a shell reparented to pid 1 with no CPU time', () => {
    // The shape of a real orphan: blocked inside start-up, so it has never
    // accumulated a tick of CPU time, and tmux is gone so pid 1 adopted it.
    expect(runReaper('  501     1   0:00.00 /bin/zsh')).toContain(
      'Would reap 1 orphaned shell(s): 501',
    );
  });

  test('spares a shell that has run something, even under pid 1', () => {
    // A login shell whose parent exited is also reparented to pid 1. The CPU
    // time is what tells the two apart — this one got past start-up.
    expect(runReaper('  501     1   0:02.31 /bin/zsh')).toBe('No orphaned shells.');
  });

  test("spares a live pane's shell, which has the tmux server as its parent", () => {
    expect(runReaper('  501   900   0:00.00 /bin/zsh')).toBe('No orphaned shells.');
  });

  test('spares a non-shell process parked under pid 1 with no CPU time', () => {
    expect(runReaper('  501     1   0:00.00 /usr/bin/tail')).toBe('No orphaned shells.');
  });

  test('recognises a login shell by its leading dash', () => {
    expect(runReaper('  501     1   0:00.00 -zsh')).toContain(
      'Would reap 1 orphaned shell(s): 501',
    );
  });

  test("reads Linux's HH:MM:SS zero as zero too", () => {
    // macOS writes `0:00.00`, Linux `00:00:00`. Both mean the same thing, and
    // CI runs the Linux form.
    expect(runReaper('  501     1  00:00:00 /bin/bash')).toContain(
      'Would reap 1 orphaned shell(s): 501',
    );
  });

  test('selects every orphan in one pass and leaves the rest alone', () => {
    const output = runReaper(
      [
        '  101     1   0:00.00 /bin/zsh', // orphan
        '  102   900   0:00.00 /bin/zsh', // live pane
        '  103     1   0:00.00 /bin/bash', // orphan
        '  104     1   1:12.00 /bin/zsh', // ran something
        '  105     1   0:00.00 /usr/bin/tail', // not a shell
      ].join('\n'),
    );
    expect(output).toContain('Would reap 2 orphaned shell(s): 101 103');
  });

  test('says nothing at all when quiet', () => {
    expect(runReaper('  501     1   0:00.00 /bin/zsh', ['--dry-run', '--quiet'])).toBe('');
  });

  test('rejects an unknown argument rather than guessing', () => {
    expect(() => runReaper('', ['--reap-everything'])).toThrow();
  });
});
