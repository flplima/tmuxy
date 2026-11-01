const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { LIST_PANES_OUTPUT, LIST_PANES_JSON } = require('./helpers/fixtures');

describe('CLI pane subcommands', () => {
  describe('pane list', () => {
    test('lists panes (plain)', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[0]).toBe('list-panes');
    });

    test('lists panes --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list', '--json'], {
        env: { MOCK_TMUX_LIST_PANES: LIST_PANES_OUTPUT },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(LIST_PANES_JSON);
    });

    test('lists panes --all --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'list', '--all', '--json'], {
        env: { MOCK_TMUX_LIST_PANES: LIST_PANES_OUTPUT },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toContain('-s');
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual(LIST_PANES_JSON);
    });
  });

  describe('pane split', () => {
    test('splits pane (default vertical)', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy splitw -P -F '##{pane_id}'"]);
    });

    test('splits pane -h (horizontal), not help', () => {
      // -h is this command's own flag. It used to be swallowed by the shared
      // `--help|-h` case, so the documented horizontal split printed usage and
      // did nothing.
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split', '-h']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -h -P -F '##{pane_id}'",
      ]);
    });

    test('--help still prints usage without splitting', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'split', '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy pane split');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('splits pane -v (vertical)', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'split', '-v']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -v -P -F '##{pane_id}'",
      ]);
    });

    test('splits pane --json outputs paneId JSON', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'split', '-h', '--json']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw -h -P -F '##{pane_id}'",
      ]);
      expect(JSON.parse(stdout)).toHaveProperty('paneId');
    });
  });

  describe('pane kill', () => {
    test('kills current pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy killp']);
    });

    test('kills specific pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'kill', '%5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy killp -t '%5'"]);
    });
  });

  describe('pane select', () => {
    test.each([
      ['-U', 'selectp -U'],
      ['-D', 'selectp -D'],
      ['-L', 'selectp -L'],
      ['-R', 'selectp -R'],
    ])('selects pane %s', (dir, expected) => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'select', dir]);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L tmuxy ${expected}`]);
    });

    test('selects pane by ID', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'select', '%3']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy selectp -t '%3'"]);
    });

    test('errors with no argument', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'select']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('pane direction or target required');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('a flag it does not know is a usage error', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'select', '-x']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("invalid argument '-x'");
      expect(tmuxCalls).toHaveLength(0);
    });

    // A word is a label: with no pane labeled or titled so, nothing happens.
    test('a label naming no pane is exit 3, and selects nothing', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'select', 'badarg']);
      expect(exitCode).toBe(3);
      expect(stderr).toContain("no pane labeled or titled 'badarg'");
      expect(tmuxCalls.some((call) => call.args[0] === 'run-shell')).toBe(false);
    });
  });

  /** Arguments are spliced into the command line, so only known ones pass. */
  test.each([
    [['pane', 'split', '; send-keys -t %3 id Enter #']],
    [['pane', 'split', '-t', '%3', 'cmd']],
    [['pane', 'resize', '-U', '5;', 'send-keys']],
    [['pane', 'resize', '-x', '10']],
  ])('refuses %p rather than splicing it into the command', (args) => {
    const { exitCode, tmuxCalls } = runCLI(args);
    expect(exitCode).not.toBe(0);
    expect(tmuxCalls.some((call) => call.args[0] === 'run-shell')).toBe(false);
  });

  describe('pane resize', () => {
    test('resizes pane in direction', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'resize', '-U']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -U']);
    });

    test('resizes pane with count', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'resize', '-D', '5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -D 5']);
    });

    test('errors with no direction', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'resize']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('direction required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pane swap', () => {
    test('swaps two panes', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'swap', '%0', '%1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy swap-pane -s '%0' -t '%1'"]);
    });

    test('errors with missing arguments', () => {
      const { stderr, exitCode } = runCLI(['pane', 'swap']);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('pane zoom', () => {
    test('toggles zoom', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'zoom']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', 'tmux -L tmuxy resizep -Z']);
    });
  });

  describe('the pane an outside caller acts on', () => {
    // From a script, a test or an SSH agent the CLI has no $TMUX_PANE, and
    // tmux would answer a target-less command with whichever session it
    // touched last — after `pane group add` has parked a member in the
    // hidden stash session, that is the stash, where no client looks. So
    // the CLI asks first, with the server's own preference: an attached
    // real session over an idle one, and never the stash.
    test('resolves the attached real session, skipping the stash', () => {
      const { exitCode, paneResolution, tmuxCalls } = runCLI(['tab', 'create'], {
        env: { MOCK_TMUX_CALLER_PANES: '0\\t__tmuxy_stash\\t%7\\n0\\tidle\\t%3\\n1\\tmain\\t%0' },
      });
      expect(exitCode).toBe(0);
      expect(paneResolution).not.toBeNull();
      expect(paneResolution.args.slice(0, 3)).toEqual(['list-panes', '-a', '-f']);
      // The answer rides to the client run-shell spawns as its TMUX_PANE —
      // run-shell hands it none of its own — and the break names its session
      // rather than trusting tmux's "current" one.
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args[1]).toMatch(/^TMUX_PANE=%0 tmux -L tmuxy splitw /);
      expect(tmuxCalls[0].args[1]).toContain("breakp -t '#{session_id}:'");
    });

    test('a pane of its own is never second-guessed', () => {
      const { paneResolution } = runCLI(['tab', 'create'], {
        env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%4' },
      });
      expect(paneResolution).toBeNull();
    });
  });

  describe('pane break', () => {
    test('breaks pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'break']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy breakp -t '#{session_id}:' -P -F '##{window_id}'",
      ]);
    });
  });

  describe('pane capture', () => {
    test('captures current pane (plain)', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'capture'], {
        env: { MOCK_TMUX_CAPTURE: 'hello world' },
      });
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('hello world');
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toContain('capture-pane');
    });

    test('captures specific pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'capture', '%5']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%5']);
    });

    test('captures with --json', () => {
      const { stdout, exitCode } = runCLI(['pane', 'capture', '--json'], {
        env: { MOCK_TMUX_CAPTURE: 'test content' },
      });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ content: 'test content', format: 'text', paneId: '' });
    });

    test('captures specific pane with --json', () => {
      const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'capture', '%2', '--json'], {
        env: { MOCK_TMUX_CAPTURE: 'pane 2 content' },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%2']);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual({ content: 'pane 2 content', format: 'text', paneId: '%2' });
    });
  });

  describe('pane send', () => {
    test('sends keys', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'send', 'ls', 'Enter'], {
        env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%1', MOCK_TMUX_PANE_PID: String(process.pid) },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls.find((call) => call.args[0] === 'run-shell').args).toEqual([
        'run-shell',
        "TMUX_PANE=%1 tmux -L tmuxy send-keys -t '%1' -- 'ls' 'Enter'",
      ]);
    });

    test('errors with no keys', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'send']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('keys required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pane paste', () => {
    const IN_PANE_1 = {
      TMUX_SOCKET: 'tmuxy',
      TMUX_PANE: '%1',
      MOCK_TMUX_PANE_PID: String(process.pid),
    };

    test('pastes text into the caller’s own pane', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'paste', 'hello world'], { env: IN_PANE_1 });
      expect(exitCode).toBe(0);
      // load-buffer first (per-PID buffer name), then run-shell pasteb
      const load = tmuxCalls.findIndex((call) => call.args[0] === 'load-buffer');
      expect(tmuxCalls[load].args[0]).toBe('load-buffer');
      expect(tmuxCalls[load].args[1]).toBe('-b');
      expect(tmuxCalls[load].args[2]).toMatch(/^tmuxy-cli-paste-\d+$/);
      expect(tmuxCalls[load].args[3]).toBe('-');
      const bufName = tmuxCalls[load].args[2];
      expect(tmuxCalls[load + 1].args).toEqual([
        'run-shell',
        `TMUX_PANE=%1 tmux -L tmuxy pasteb -p -d -b ${bufName} -t '%1'`,
      ]);
    });

    /** A paste into another pane is a send: the same question, first. */
    test('asks before pasting into another pane, and pastes nothing on no', () => {
      const { exitCode, tmuxCalls } = runCLI(['pane', 'paste', '-t', '%3', 'rm -rf dist'], {
        env: { ...IN_PANE_1, MOCK_TMUX_ANSWER: 'no' },
      });
      expect(exitCode).toBe(1);
      const lines = tmuxCalls.map((call) => call.args.join(' '));
      expect(lines.some((line) => line.includes('@tmuxy-ask '))).toBe(true);
      expect(lines.some((line) => line.includes('pasteb'))).toBe(false);
    });

    /**
     * Any spelling of the end marker would end a bracketed paste early and
     * run what follows it, so the text loses every control but tab, LF and
     * CR, without appending an extra trailing newline.
     */
    test.each([
      ['markers nested in each other', 'a\x1b[20\x1b[201~1~\nid', 'a[20[201~1~\nid'],
      ['a zero-padded parameter', 'echo safe\x1b[0201~; id', 'echo safe[0201~; id'],
      ['the 8-bit C1 CSI', 'echo safe\u009b201~; id', 'echo safe201~; id'],
      ['C0, DEL and C1 among the kept tab, CR and LF', 'a\x01\x07\t\x7f\r\u0085\nb', 'a\t\r\nb'],
      // © and NBSP are C2 A9 and C2 A0 in UTF-8: the C1 lead byte, kept.
      ['CJK, accents and emoji', '中文 é © Â 😀  ok', '中文 é © Â 😀  ok'],
    ])('pastes %s without its controls', (_name, text, pasted) => {
      const buffer = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-paste-')), 'buffer');
      const { exitCode } = runCLI(['pane', 'paste', text], {
        env: { ...IN_PANE_1, MOCK_TMUX_BUFFER_FILE: buffer },
      });
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(buffer, 'utf8')).toBe(pasted);
    });

    test('a text of nothing but controls pastes nothing and asks nothing', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(
        ['pane', 'paste', '-t', '%3', '\x1b\x07\u009b\x7f'],
        { env: IN_PANE_1 },
      );
      expect(exitCode).toBe(0);
      expect(stderr).toContain('nothing to paste');
      const lines = tmuxCalls.map((call) => call.args.join(' '));
      expect(lines.some((line) => /load-buffer|pasteb|@tmuxy-ask /.test(line))).toBe(false);
    });

    /** The question shows what would land, not the text before the filter. */
    test('the question into another pane carries the text without its controls', () => {
      const { exitCode, tmuxCalls } = runCLI(
        ['pane', 'paste', '-t', '%3', 'echo safe\u009b201~;\tid 中文'],
        { env: { ...IN_PANE_1, MOCK_TMUX_ANSWER: 'no' } },
      );
      expect(exitCode).toBe(1);
      const write = tmuxCalls
        .map((call) => call.args.join(' '))
        .find((line) => /@tmuxy-ask '/.test(line));
      const encoded = write.match(/@tmuxy-ask '([A-Za-z0-9+/=]*)'/)[1];
      const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      expect(payload.keys).toEqual(['echo safe201~;\tid 中文']);
    });

    test('errors with no text', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['pane', 'paste']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('text required');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('pane unknown', () => {
    test('errors on unknown pane subcommand', () => {
      const { stderr, exitCode } = runCLI(['pane', 'unknown']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown pane command: unknown');
      expect(stderr).toContain('Usage: tmuxy pane <command>');
    });
  });
});
