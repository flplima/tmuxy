const { runCLI } = require('./helpers/run-cli');

describe('CLI run escape hatch', () => {
  describe('basic routing', () => {
    test('routes arbitrary command through run-shell', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'swap-pane', '-s', '%0', '-t', '%1']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy swap-pane '-s' '%0' '-t' '%1'",
      ]);
    });

    // tmux 3.4 shows run-shell output, and a "returned 1", in view-mode on the
    // pane instead of handing it to the CLI — and a pane in view-mode swallows
    // every key. The inner tmux therefore writes its output and status to
    // files, and run-shell itself has nothing to show.
    test('brings the inner command output and exit status back through files', () => {
      const ok = runCLI(['run', 'splitw', '-P']);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('%99');
      expect(ok.rawRunShells[0].args[1]).toMatch(
        /^\{ tmux -L tmuxy splitw '-P' ; \} >'[^']*\/out' 2>'[^']*\/err'; echo \$\? >'[^']*\/status'$/,
      );

      const failed = runCLI(['run', 'move-window', '-s', ':0', '-t', ':1'], {
        env: { MOCK_TMUX_EXIT_CODE: '1' },
      });
      expect(failed.exitCode).toBe(1);
    });

    // TMUX_PANE comes from the caller's environment and is spliced into
    // the shell line run-shell runs: anything but a pane id is dropped.
    test('a TMUX_PANE that is not a pane id never reaches the shell', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes'], {
        env: { TMUX_PANE: '%3; touch /tmp/owned' },
      });
      expect(exitCode).toBe(0);
      const line = tmuxCalls[tmuxCalls.length - 1].args[1];
      expect(line).not.toContain('touch');
      expect(line).toContain('tmux -L tmuxy list-panes');
    });

    // A side-installed tmux (the version floor, say) is used end to end,
    // never the one on PATH.
    test('TMUX_BIN names the tmux both the CLI and the command it runs use', () => {
      const bin = require('path').resolve(__dirname, 'mocks/tmux');
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes'], {
        env: { TMUX_BIN: bin, TMUX_SOCKET: 'tmuxy', PATH: '/usr/bin:/bin' },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls[tmuxCalls.length - 1].args[1]).toContain(`${bin} -L tmuxy list-panes`);
    });

    test('a socket path with a space is quoted for the shell', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes'], {
        env: { TMUX_SOCKET: '/tmp/my sockets/tmuxy' },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls[tmuxCalls.length - 1].args[1]).toContain(
        "tmux -S '/tmp/my sockets/tmuxy' list-panes",
      );
    });

    test('errors with no command', () => {
      const { stderr, exitCode } = runCLI(['run']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('tmux command required');
      expect(stderr).toContain('Usage: tmuxy run <tmux-command>');
    });
  });

  /**
   * `tmuxy pane send -t` asks the user before typing into another pane;
   * `tmuxy run` is the CLI's other door to tmux, and must not be a way past
   * that question.
   */
  describe('the send question cannot be gone around', () => {
    const IN_PANE_1 = {
      TMUX_SOCKET: 'tmuxy',
      TMUX_PANE: '%1',
      MOCK_TMUX_PANE_PID: String(process.pid),
    };
    const refused = (args, env = IN_PANE_1) => {
      const result = runCLI(['run', ...args], { env });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('refused');
      expect(result.tmuxCalls.some((call) => call.args[0] === 'run-shell')).toBe(false);
    };

    test.each([
      [['send-keys', '-t', '%3', 'rm -rf ~', 'Enter']],
      [['send', '-t%3', 'id', 'Enter']],
      [['send-k', '-lt', '%3', 'id']],
      [['paste-buffer', '-t', '%3']],
      [['pasteb', '-p', '-t', '%3']],
      [['pipe-pane', '-t', '%3', '-I', 'echo id']],
    ])('refuses input into another pane: %p', (args) => refused(args));

    test('refuses input from a caller that only claims to be in the pane', () => {
      refused(['send-keys', '-t', '%1', 'id', 'Enter'], {
        ...IN_PANE_1,
        MOCK_TMUX_PANE_PID: '999999',
      });
    });

    test.each([
      [['run-shell', 'tmux send-keys -t %3 id Enter']],
      [['if-shell', 'true', 'send-keys -t %3 id Enter']],
      [['respawn-pane', '-k', '-t', '%3', 'id']],
      [['set-environment', '-g', 'TMUXY_SERVER_BIN', '/tmp/evil']],
      [['set-hook', '-g', 'pane-focus-in', 'send-keys id']],
      [['source-file', '/tmp/evil.conf']],
    ])('refuses what runs a shell: %p', (args) => refused(args));

    test.each([
      [['set-option', '-p', '-t', '%3', '@tmuxy-ask-answer', '3-1:yes']],
      [['set', '-g', '@tmuxy-send-ask', 'off']],
      [['set', '-g', '@tmuxy-send-allow', 'claude']],
      [['set-option', '-p', '-t', '%3', '@tmuxy-pane-restore', 'id']],
    ])('refuses writes to the question’s own options: %p', (args) => refused(args));

    test('refuses a command name that is not one word', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes; touch /tmp/owned']);
      expect(exitCode).not.toBe(0);
      expect(tmuxCalls).toHaveLength(0);
    });

    test('a whole command in one argument is checked word by word', () => {
      refused(['send-keys -t %3 "rm -rf ~" Enter']);
      refused(['list-panes; touch /tmp/owned']);
      refused(['list-panes $(touch /tmp/owned)']);
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-sessions -F "#{session_name}"']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[tmuxCalls.length - 1].args[1]).toContain(
        'tmux -L tmuxy list-sessions -F "#{session_name}"',
      );
    });

    test('still runs an ordinary set', () => {
      const { exitCode } = runCLI(['run', 'set', '-g', 'status', 'off']);
      expect(exitCode).toBe(0);
    });
  });

  describe('new-window interception', () => {
    test('intercepts new-window and uses safe alternative', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'new-window']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted for safety');
      // It IS `tmuxy tab create`: one run-shell with the atomic splitw+breakp
      // command list — never a direct external tmux invocation, which would
      // crash tmux 3.5a with control mode attached.
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw \\; breakp -t '#{session_id}:' -P -F '##{window_id}'",
      ]);
    });

    test('intercepts neww alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'neww']);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('new-window intercepted');
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw \\; breakp -t '#{session_id}:' -P -F '##{window_id}'",
      ]);
    });

    test('intercepts new-window with -n name', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'new-window', '-n', 'my-win']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls).toHaveLength(1);
      expect(tmuxCalls[0].args).toEqual([
        'run-shell',
        "tmux -L tmuxy splitw \\; breakp -t '#{session_id}:' -n 'my-win' -P -F '##{window_id}'",
      ]);
    });
  });

  describe('resize-window blocking', () => {
    test('blocks resize-window', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resize-window']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      // Wording matches docs/TMUX.md: externally-sent resize-window is
      // ignored, not a crash — the group scripts issue it from run-shell.
      expect(stderr).toContain('unreliable with control mode');
      expect(tmuxCalls).toHaveLength(0);
    });

    test('blocks resizew alias', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['run', 'resizew']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('resize-window is blocked');
      expect(tmuxCalls).toHaveLength(0);
    });
  });

  describe('argument quoting', () => {
    test('keeps an argument containing spaces intact', () => {
      // run_safe used to interpolate $* into the run-shell string, so
      // `rename-window "my tab"` reached tmux as two separate words.
      const { exitCode, tmuxCalls } = runCLI(['run', 'rename-window', 'my tab']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy rename-window 'my tab'"]);
    });

    test('doubles # so run-shell does not format-expand it', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'rename-window', '#{pane_id}']);
      expect(exitCode).toBe(0);
      expect(tmuxCalls[0].args).toEqual(['run-shell', "tmux -L tmuxy rename-window '##{pane_id}'"]);
    });
  });

  describe('pass-through commands', () => {
    test('passes send-keys into the caller’s own pane through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'send-keys', '-t', '%3', '-X', 'cancel'], {
        env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%3', MOCK_TMUX_PANE_PID: String(process.pid) },
      });
      expect(exitCode).toBe(0);
      expect(tmuxCalls.find((call) => call.args[0] === 'run-shell').args).toEqual([
        'run-shell',
        "TMUX_PANE=%3 tmux -L tmuxy send-keys '-t' '%3' '-X' 'cancel'",
      ]);
    });

    test('passes list-panes through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes']);
      expect(exitCode).toBe(0);
      // run_safe adds trailing space when no args: "tmux -L tmuxy list-panes "
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(/^tmux -L tmuxy list-panes\s*$/);
    });
  });
});
