/**
 * `tmuxy session save|restore|snapshots|forget` and `tmuxy pane restore-cmd`.
 *
 * The CLI owns two things here and they are what these tests hold still:
 * which verbs may run tmux as a bare subprocess (the reads) and which must go
 * through `run-shell` (anything that creates, splits or kills, which crashes
 * tmux 3.5a as a subprocess while control mode is attached — docs/TMUX.md).
 * The snapshot logic itself is Rust, tested in `tmuxy_core::session_snapshot`.
 */

const path = require('path');
const { runCLI } = require('./helpers/run-cli');

const { SOCKET } = require('./helpers/env');

const WORDS = require(
  path.resolve(__dirname, '../../packages/tmuxy-cli/bin/tmuxy/session-names.json'),
);
const PAIRS = WORDS.adjectives.flatMap((adjective) =>
  WORDS.nouns.map((noun) => `${adjective}-${noun}`),
);

describe('tmuxy session snapshots', () => {
  test('save and snapshots are reads: handed to the binary, no run-shell', () => {
    const save = runCLI(['session', 'save', 'work', '--scrollback', '50']);
    expect(save.exitCode).toBe(0);
    expect(save.stdout).toContain('mock-server-started session save work --scrollback 50');
    expect(save.tmuxCalls).toHaveLength(0);

    const list = runCLI(['session', 'snapshots']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('mock-server-started session snapshots');
    expect(list.tmuxCalls).toHaveLength(0);
  });

  /** A rebuild creates and splits, so it runs inside tmux, never beside it. */
  test('restore goes through run-shell, with its flags', () => {
    const { exitCode, tmuxCalls } = runCLI(['session', 'restore', 'work']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].args[0]).toBe('run-shell');
    expect(tmuxCalls[0].args[1]).toMatch(/tmuxy-server'? session restore 'work'$/);
  });

  /**
   * `--run` starts every saved command unasked. A script or an agent has no
   * terminal; it gets the restore with the commands offered instead.
   */
  test('restore --run without a terminal is refused, running nothing', () => {
    const { exitCode, stderr, tmuxCalls } = runCLI(['session', 'restore', 'work', '--run']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--run needs a terminal');
    expect(tmuxCalls).toHaveLength(0);
  });

  /** `--force` kills a running session first, which is a mutation. */
  test('forget goes through run-shell too', () => {
    const { exitCode, tmuxCalls } = runCLI(['session', 'forget', 'work', '--force']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(1);
    expect(tmuxCalls[0].args[0]).toBe('run-shell');
    expect(tmuxCalls[0].args[1]).toMatch(/session forget 'work' '--force'$/);
  });

  test('the help names every verb and the restore tag', () => {
    const { stdout, exitCode } = runCLI(['session', '--help']);
    expect(exitCode).toBe(0);
    for (const verb of ['save', 'restore', 'snapshots', 'forget']) {
      expect(stdout).toContain(verb);
    }
    expect(stdout).toContain('tmuxy pane restore-cmd');
  });
});

describe('tmuxy pane restore-cmd', () => {
  /** A caller that really runs in pane %7: its pane's process is the suite's. */
  const IN_PANE_7 = {
    TMUX_PANE: '%7',
    MOCK_TMUX_PANE_PID: String(process.pid),
  };

  /** The run-shell calls, past the read that checks the caller's pane. */
  const runShells = (tmuxCalls) => tmuxCalls.filter((call) => call.args[0] === 'run-shell');

  test('writes the pane option for the calling pane, through run-shell', () => {
    const { exitCode, tmuxCalls } = runCLI(['pane', 'restore-cmd', 'claude --resume abc'], {
      env: IN_PANE_7,
    });
    expect(exitCode).toBe(0);
    expect(runShells(tmuxCalls)).toHaveLength(1);
    expect(runShells(tmuxCalls)[0].args).toEqual([
      'run-shell',
      `TMUX_PANE=%7 tmux -L ${SOCKET} set-option -p -t '%7' @tmuxy-pane-restore 'claude --resume abc'`,
    ]);
  });

  test('clears with --clear, naming its own pane or not', () => {
    const clear = runCLI(['pane', 'restore-cmd', '--clear', '%7'], { env: IN_PANE_7 });
    expect(clear.exitCode).toBe(0);
    expect(runShells(clear.tmuxCalls)[0].args[1]).toBe(
      `TMUX_PANE=%7 tmux -L ${SOCKET} set-option -p -u -t '%7' @tmuxy-pane-restore`,
    );
  });

  /**
   * A restore offers the command in its pane, or runs it with --run: setting
   * one on another pane would be typing there without asking.
   */
  test("never writes another pane's, nor one for a caller that only claims a pane", () => {
    const other = runCLI(['pane', 'restore-cmd', 'nvim -S', '%3'], { env: IN_PANE_7 });
    expect(other.exitCode).not.toBe(0);
    expect(runShells(other.tmuxCalls)).toHaveLength(0);
    const claimed = runCLI(['pane', 'restore-cmd', 'nvim -S'], {
      env: { TMUX_PANE: '%7', MOCK_TMUX_PANE_PID: '999999' },
    });
    expect(claimed.exitCode).not.toBe(0);
    expect(runShells(claimed.tmuxCalls)).toHaveLength(0);
  });

  test('refuses with nothing to write and no pane to target', () => {
    expect(runCLI(['pane', 'restore-cmd'], { env: IN_PANE_7 }).exitCode).not.toBe(0);
    expect(runCLI(['pane', 'restore-cmd', 'vim'], { env: { TMUX_PANE: '' } }).exitCode).not.toBe(0);
  });
});

describe('tmuxy session switch: new', () => {
  /** What `new` made, from the run-shell that made it. */
  const created = (taken, snapshots = []) => {
    const { exitCode, tmuxCalls, stdout } = runCLI(['session', 'switch'], {
      input: 'new\n',
      env: {
        MOCK_TMUX_LIST_SESSIONS: taken.join('\\n'),
        MOCK_SERVER_SNAPSHOTS: snapshots
          .map((name) => `${name}\\t2026-10-25 10:00\\texited`)
          .join('\\n'),
      },
    });
    expect(exitCode).toBe(0);
    const create = tmuxCalls.find((call) => /new-session/.test(call.args[1] ?? ''));
    expect(create.args[0]).toBe('run-shell');
    const name = create.args[1].match(/new-session -d -s '([^']+)'$/)[1];
    expect(stdout).toContain(name);
    return name;
  };

  test('names the session with an adjective and a noun from the shared lists', () => {
    expect(PAIRS).toContain(created(['tmuxy', 'work']));
  });

  test('never takes a name a session already has', () => {
    const free = PAIRS[PAIRS.length - 1];
    expect(created(PAIRS.filter((name) => name !== free))).toBe(free);
  });

  /** A session made under a snapshot's name would be saved over the snapshot. */
  test("never takes a snapshot's name either", () => {
    // The snapshot comes first from almost any start, so only the check skips it.
    const [saved, free] = PAIRS.slice(-2);
    expect(created(PAIRS.slice(0, -2), [saved])).toBe(free);
  });

  test('adds a number only once every pair is taken', () => {
    const name = created([...PAIRS, ...PAIRS.map((pair) => `${pair}-2`)]);
    expect(name).toMatch(/^[a-z]+-[a-z]+-3$/);
    expect(PAIRS).toContain(name.replace(/-3$/, ''));
  });
});

describe('tmuxy session new | rename | kill', () => {
  const sessionsEnv = (...names) => ({ MOCK_TMUX_LIST_SESSIONS: names.join('\\n') });
  const runShells = (tmuxCalls) => tmuxCalls.filter((call) => call.args[0] === 'run-shell');

  test('new makes a detached session under a memorable name, through run-shell', () => {
    const { exitCode, stdout, tmuxCalls } = runCLI(['session', 'new'], {
      env: sessionsEnv('tmuxy'),
    });
    expect(exitCode).toBe(0);
    const name = stdout.trim();
    expect(PAIRS).toContain(name);
    expect(runShells(tmuxCalls)).toHaveLength(1);
    expect(runShells(tmuxCalls)[0].args[1]).toBe(`tmux -L ${SOCKET} new-session -d -s '${name}'`);
  });

  test('new takes a name, a --cwd and a command for the first pane', () => {
    const { exitCode, stdout, tmuxCalls } = runCLI(
      ['session', 'new', 'build', '--cwd', '/tmp', '--', 'npm', 'run', 'it is'],
      { env: sessionsEnv('tmuxy') },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('build');
    expect(runShells(tmuxCalls)[0].args[1]).toBe(
      `tmux -L ${SOCKET} new-session -d -s 'build' -c '/tmp' ` +
        String.raw`''\''npm'\'' '\''run'\'' '\''it is'\'''`,
    );
  });

  test('new --json answers the name', () => {
    const { exitCode, stdout } = runCLI(['session', 'new', 'build', '--json'], {
      env: sessionsEnv('tmuxy'),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, session: 'build' });
  });

  test('new with a name that exists exits 1 and creates nothing', () => {
    const { exitCode, stderr, tmuxCalls } = runCLI(['session', 'new', 'work'], {
      env: sessionsEnv('tmuxy', 'work'),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("a session named 'work' exists");
    expect(runShells(tmuxCalls)).toHaveLength(0);
  });

  test('new --cwd with no such directory exits 2; a bad name exits 2', () => {
    const missing = runCLI(['session', 'new', 'a', '--cwd', '/no/such/dir']);
    expect(missing.exitCode).toBe(2);
    expect(runShells(missing.tmuxCalls)).toHaveLength(0);
    expect(runCLI(['session', 'new', 'a.b']).exitCode).toBe(2);
    expect(runCLI(['session', 'new', '__tmuxy_stash']).exitCode).toBe(2);
  });

  test('rename acts on the named session, or on the current one', () => {
    const named = runCLI(['session', 'rename', 'work', 'play', '--json'], {
      env: sessionsEnv('tmuxy', 'work'),
    });
    expect(named.exitCode).toBe(0);
    expect(JSON.parse(named.stdout)).toEqual({ ok: true, session: 'play' });
    expect(runShells(named.tmuxCalls)[0].args[1]).toBe(
      `tmux -L ${SOCKET} rename-session -t '=work' 'play'`,
    );
    const current = runCLI(['session', 'rename', 'play'], {
      env: { ...sessionsEnv('tmuxy'), MOCK_TMUX_SESSION: 'tmuxy' },
    });
    expect(current.exitCode).toBe(0);
    expect(current.stdout.trim()).toBe('play');
    expect(runShells(current.tmuxCalls)[0].args[1]).toBe(
      `tmux -L ${SOCKET} rename-session -t '=tmuxy' 'play'`,
    );
  });

  test('rename refuses an empty name, a taken one and a missing session', () => {
    const env = sessionsEnv('tmuxy', 'work');
    expect(runCLI(['session', 'rename', ''], { env }).exitCode).toBe(2);
    const taken = runCLI(['session', 'rename', 'work', 'tmuxy'], { env });
    expect(taken.exitCode).toBe(1);
    expect(runShells(taken.tmuxCalls)).toHaveLength(0);
    const missing = runCLI(['session', 'rename', 'gone', 'x'], { env });
    expect(missing.exitCode).toBe(3);
  });

  test('kill takes a session by name, through run-shell', () => {
    const { exitCode, stdout, tmuxCalls } = runCLI(['session', 'kill', 'work', '--json'], {
      env: sessionsEnv('tmuxy', 'work'),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, session: 'work' });
    expect(runShells(tmuxCalls)[0].args[1]).toBe(`tmux -L ${SOCKET} kill-session -t '=work'`);
  });

  test('kill with no name exits 2, with a missing session exits 3; nothing is killed', () => {
    const none = runCLI(['session', 'kill'], { env: sessionsEnv('tmuxy') });
    expect(none.exitCode).toBe(2);
    const missing = runCLI(['session', 'kill', 'gone', '--json'], { env: sessionsEnv('tmuxy') });
    expect(missing.exitCode).toBe(3);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, code: 3 });
    expect(runShells(none.tmuxCalls)).toHaveLength(0);
    expect(runShells(missing.tmuxCalls)).toHaveLength(0);
  });

  test('the help lists the three, each has its own, and kill says what happens to the snapshot', () => {
    const { stdout } = runCLI(['session', '--help']);
    for (const verb of ['new', 'rename', 'kill'])
      expect(stdout).toMatch(new RegExp(`^  ${verb} `, 'm'));
    for (const verb of ['new', 'rename', 'kill']) {
      const help = runCLI(['session', verb, '--help']);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain(`Usage: tmuxy session ${verb}`);
    }
    expect(runCLI(['session', 'kill', '--help']).stdout).toContain('snapshot stays');
  });
});
