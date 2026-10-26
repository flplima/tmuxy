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
    TMUX_SOCKET: 'tmuxy',
    TMUX_PANE: '%7',
    MOCK_TMUX_PANE_PID: String(process.pid),
  };

  /** The run-shell calls, past the read that checks the caller's pane. */
  const runShells = (tmuxCalls) => tmuxCalls.filter((call) => call.args[0] === 'run-shell');

  test('writes the pane option for the calling pane, through run-shell', () => {
    const { exitCode, tmuxCalls } = runCLI(['pane', 'restore-cmd', 'claude --resume abc'], {
      // The harness drops TMUX_PANE unless a socket is pinned, since the suite
      // itself usually runs inside a pane.
      env: IN_PANE_7,
    });
    expect(exitCode).toBe(0);
    expect(runShells(tmuxCalls)).toHaveLength(1);
    expect(runShells(tmuxCalls)[0].args).toEqual([
      'run-shell',
      "TMUX_PANE=%7 tmux -L tmuxy set-option -p -t '%7' @tmuxy-pane-restore 'claude --resume abc'",
    ]);
  });

  test('clears with --clear, naming its own pane or not', () => {
    const clear = runCLI(['pane', 'restore-cmd', '--clear', '%7'], { env: IN_PANE_7 });
    expect(clear.exitCode).toBe(0);
    expect(runShells(clear.tmuxCalls)[0].args[1]).toBe(
      "TMUX_PANE=%7 tmux -L tmuxy set-option -p -u -t '%7' @tmuxy-pane-restore",
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
      env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%7', MOCK_TMUX_PANE_PID: '999999' },
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
    const { exitCode, tmuxCalls, stdout } = runCLI(['session', 'switch', '--float'], {
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
    // The float hands the switch on by the same name.
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
