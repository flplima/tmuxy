const { runCLI } = require('./helpers/run-cli');

describe('CLI session commands', () => {
  describe('session help', () => {
    test.each([
      [['session'], 'Usage: tmuxy session <command>'],
      [['session', '--help'], 'Usage: tmuxy session <command>'],
      [['session', '-h'], 'Usage: tmuxy session <command>'],
    ])('tmuxy %j shows session usage', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('session subcommand help', () => {
    test.each([
      [['session', 'switch', '--help'], 'Usage: tmuxy session switch'],
      [['session', 'switch', '-h'], 'Usage: tmuxy session switch'],
      [['session', 'connect', '--help'], 'Usage: tmuxy session connect'],
      [['session', 'connect', '-h'], 'Usage: tmuxy session connect'],
    ])('tmuxy %j shows help', (args, expected) => {
      const { stdout, exitCode } = runCLI(args);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(expected);
    });
  });

  describe('session connect --web', () => {
    test('shows not-supported message', () => {
      const { stdout, exitCode } = runCLI(['session', 'connect', '--web']);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('SSH connections are only available in the Tauri desktop app');
    });
  });

  describe('unknown session subcommand', () => {
    test('shows error and usage', () => {
      const { stderr, exitCode } = runCLI(['session', 'unknown']);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('Unknown session command');
    });
  });

  /**
   * SEC-24. The switcher hands the chosen name to `run-shell`, which
   * format-expands its string (`#(...)` runs a command) before a shell parses
   * it (a stray quote ends the word). A session is named by whoever created
   * it, so the name is quoted for both, not trusted.
   */
  describe('session switch --float with a hostile session name', () => {
    const hostile = "a'b#(true)";

    test('the name reaches run-shell as one quoted word with its # doubled', () => {
      const { exitCode, stdout, tmuxCalls } = runCLI(['session', 'switch', '--float'], {
        input: '2\n',
        env: {
          MOCK_TMUX_SESSION: 'main',
          MOCK_TMUX_LIST_SESSIONS: `main\n${hostile}`,
        },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain(hostile);

      const setEnv = tmuxCalls
        .filter((call) => call.args[0] === 'run-shell')
        .map((call) => call.args[1])
        .find((cmd) => cmd.includes('set-environment -g TMUXY_SWITCH_TO'));
      expect(setEnv).toBeDefined();
      // `shquote`: single-quoted, the embedded quote escaped, `#` doubled so
      // run-shell's format expansion yields a literal `#` — never `#(true)`.
      expect(setEnv).toContain("TMUXY_SWITCH_TO 'a'\\''b##(true)'");
      expect(setEnv).not.toMatch(/[^#]#\(true\)/);
    });
  });

  describe('top-level help includes session', () => {
    test('session listed in top-level help', () => {
      const { stdout } = runCLI(['--help']);
      expect(stdout).toContain('session');
    });
  });
});
