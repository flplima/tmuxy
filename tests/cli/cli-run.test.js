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
      const ok = runCLI(['run', 'breakp', '-P']);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('@99');
      expect(ok.rawRunShells[0].args[1]).toMatch(
        /^\{ tmux -L tmuxy breakp '-P' ; \} >'[^']*\/out' 2>'[^']*\/err'; echo \$\? >'[^']*\/status'$/,
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
      expect(exitCode).toBe(2);
      expect(stderr).toContain('tmux command required');
      expect(stderr).toContain('Usage: tmuxy run <tmux-command>');
    });
  });

  /**
   * `tmuxy pane send -t` asks the user before typing into another pane;
   * `tmuxy run` is the CLI's other door to tmux, and must not be a way past
   * that question — neither by typing itself nor by running a shell, which
   * can run any tmux it likes. It passes on a list of commands, by exact
   * name, and quotes every argument.
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
    const runShellLine = (args) => {
      const { exitCode, tmuxCalls } = runCLI(['run', ...args], { env: IN_PANE_1 });
      expect(exitCode).toBe(0);
      return tmuxCalls.find((call) => call.args[0] === 'run-shell').args[1];
    };

    test.each([
      [['send-keys', '-t', '%3', 'rm -rf ~', 'Enter']],
      [['send', '-t%3', 'id', 'Enter']],
      [['send-k', '-lt', '%3', 'id']],
      [['paste-buffer', '-t', '%3']],
      [['pasteb', '-p', '-t', '%3']],
      [['pipe-pane', '-t', '%3', '-I', 'echo id']],
      // tmux takes the LAST -t, so naming the caller's own pane first is no
      // proof of where the keys go.
      [['send-keys', '-t', '%1', '-t', '%3', 'id', 'Enter']],
      // Its own pane too: synchronize-panes, or a -F format, takes keys
      // typed there further.
      [['send-keys', '-t', '%1', '-X', 'cancel']],
      [['send-keys', 'id', 'Enter']],
    ])('refuses input into a pane: %p', (args) => refused(args));

    test.each([
      [['run-shell', 'tmux send-keys -t %3 id Enter']],
      [['if-shell', 'true', 'send-keys -t %3 id Enter']],
      [['respawn-pane', '-k', '-t', '%3', 'id']],
      [['set-environment', '-g', 'TMUXY_SERVER_BIN', '/tmp/evil']],
      [['set-hook', '-g', 'pane-focus-in', 'send-keys id']],
      [['source-file', '/tmp/evil.conf']],
      // A unique prefix is a name to tmux: `i` is if-shell.
      [['i', 'true', 'run-shell id']],
      [['run-s', 'id']],
      // Commands that take a shell command or a command to run later.
      [['split-window', '-d', 'id']],
      [['splitw', 'id']],
      [['new-session', '-d', 'id']],
      [['display-popup', '-E', 'id']],
      [['bind-key', '-n', 'F12', 'run-shell id']],
      [['command-prompt', '-I', 'x', 'run-shell %%']],
      [['confirm-before', 'run-shell id']],
      [['choose-tree', 'run-shell id']],
      [['detach-client', '-E', 'id']],
      [['lock-server']],
      // An option can run a shell, alias a command, or mirror keys.
      [['set', '-s', 'command-alias[100]', 'zz=run-shell id']],
      [['set-option', '-g', 'status-right', '#(id)']],
      [['set', '-g', 'default-command', 'id']],
      [['setw', 'synchronize-panes', 'on']],
    ])('refuses what runs a shell or sets an option: %p', (args) => refused(args));

    test.each([
      [['set-option', '-p', '-t', '%3', '@tmuxy-ask-answer', '3-1:yes']],
      [['set', '-g', '@tmuxy-send-ask', 'off']],
      [['set', '-g', '@tmuxy-send-allow', 'claude']],
      [['set-option', '-p', '-t', '%3', '@tmuxy-pane-restore', 'id']],
    ])('refuses writes to the question’s own options: %p', (args) => refused(args));

    // An argument ending in `;` ends one tmux command and starts the next.
    test.each([
      [['display-message', 'x', ';', 'run-shell', 'id']],
      [['display-message', 'x;', 'run-shell', 'id']],
      [['display-message x ; run-shell id']],
      [['list-panes; touch /tmp/owned']],
    ])('refuses a second command chained with ;: %p', (args) => refused(args));

    // A format that runs a shell, or that expands a value (a pane title, a
    // path) as a format again.
    test.each([
      [['display-message', '-p', '#(id)']],
      [['list-panes', '-F', '#{?pane_active,#(id),}']],
      [['display-message', '-p', '#{E:pane_title}']],
      [['display-message', '-p', '#{T;=10:pane_current_path}']],
    ])('refuses a format that can run a shell: %p', (args) => refused(args));

    // run-shell format-expands its line before its shell reads it: a format
    // left bare there can spell `;` (`#{a:59}`) and end the tmux command.
    test('a whole command in one argument reaches tmux quoted, word by word', () => {
      expect(runShellLine(['list-panes #{a:59}id'])).toBe(
        "TMUX_PANE=%1 tmux -L tmuxy list-panes '##{a:59}id'",
      );
      expect(runShellLine(['list-panes $(touch /tmp/owned)'])).toBe(
        "TMUX_PANE=%1 tmux -L tmuxy list-panes '$(touch' '/tmp/owned)'",
      );
      expect(runShellLine(['list-sessions -F "#{session_name} #{session_attached}"'])).toBe(
        "TMUX_PANE=%1 tmux -L tmuxy list-sessions '-F' '##{session_name} ##{session_attached}'",
      );
      refused(['send-keys -t %3 "rm -rf ~" Enter']);
    });

    test.each([
      [['list-panes', '-F', '#{pane_id} #{?pane_active,active,}']],
      [['display-message', '-p', '#{session_name}']],
      [['select-pane', '-t', '%3', '-T', 'build']],
      [['swap-pane', '-s', '%0', '-t', '%1']],
      [['move-window', '-s', 'work:0', '-t', 'work:1']],
      [['copy-mode', '-q', '-t', '%3']],
      [['kill-session', '-t', 'scratch']],
    ])('still runs what reads, arranges or closes: %p', (args) => {
      expect(runShellLine(args)).toContain(`tmux -L tmuxy ${args[0]} `);
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
    test('passes list-panes through', () => {
      const { exitCode, tmuxCalls } = runCLI(['run', 'list-panes']);
      expect(exitCode).toBe(0);
      // run_safe adds trailing space when no args: "tmux -L tmuxy list-panes "
      expect(tmuxCalls[0].args[0]).toBe('run-shell');
      expect(tmuxCalls[0].args[1]).toMatch(/^tmux -L tmuxy list-panes\s*$/);
    });
  });
});
