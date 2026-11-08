const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

/**
 * `tmuxy pane float` (`bin/tmuxy/float-create`) makes the float with the
 * server binary's `float` verb — one command list, built by `tmuxy_core::float`
 * and tested there, its sizes and refusals in `tmuxy-verbs/src/float_cli.rs`.
 * The script keeps what a shell does: reusing the float it runs in, and
 * running a command in the float, waiting for it and closing the float. The
 * mock server logs the verb's command line and answers `%99 @98`.
 */
describe('CLI pane float', () => {
  const floatEnv = {
    TMUX_SOCKET: 'tmuxy',
    TMUX_PANE: '%5',
    MOCK_TMUX_WINDOW_ID: '@3',
  };

  /** Run `pane float …` and read back the float verb's command line. */
  function float(args, env = {}) {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-float-')), 'server.log');
    const result = runCLI(['pane', 'float', ...args], {
      env: { ...floatEnv, MOCK_SERVER_LOG: log, ...env },
    });
    const verb = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
    return { ...result, verb };
  }

  test('makes the float from the caller’s pane, with the options it was given', () => {
    const { stdout, exitCode, verb, tmuxCalls } = float([
      '--left',
      '--width',
      '50',
      '--bg',
      'blur',
      '--hide-header',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('%99');
    expect(verb).toBe('float --pane %5 --drawer left --width 50 --bg blur --hide-header');
    // The whole float is the verb's one list: the script itself mutates nothing.
    expect(tmuxCalls.filter((c) => c.args[0] === 'run-shell')).toHaveLength(0);
  });

  /**
   * `--detach` is what an MCP client's `pane_float` runs inside run-shell:
   * the command is the float's own program, each word quoted for the shell,
   * and the pane id comes back at once. Waiting for the command there would
   * hold the server's control-mode queue until it exited.
   */
  test('a detached float runs its command and answers its pane id without waiting', () => {
    const { stdout, exitCode, verb, tmuxCalls } = float([
      '--detach',
      '--',
      'bash',
      '-c',
      'echo "a b"; sleep 9',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('%99');
    expect(verb).toBe('float --pane %5 --command bash -c echo\\ \\"a\\ b\\"\\;\\ sleep\\ 9');
    expect(tmuxCalls.some((c) => c.args[0] === 'wait-for')).toBe(false);
  });

  test('a float running a command closes its own window, never the caller tab', () => {
    // The float's ids come from the list that makes it, and only its window
    // is closed: the caller's window is @3, the float's @98.
    const { exitCode, tmuxCalls } = float(['echo', 'hi'], { MOCK_TMUX_LIST_PANES: '4242' });
    expect(exitCode).toBe(0);
    const kills = tmuxCalls.filter(
      (c) => c.args[0] === 'run-shell' && c.args[1].includes('kill-window'),
    );
    expect(kills).toHaveLength(1);
    expect(kills[0].args[1]).toContain('kill-window -t @98');
  });

  // `tmuxy pane float [cmd args...]` runs the program with the arguments it
  // was given, as `pane run` does: a word with a space, a quote, a `$` or a
  // `;` reaches it as that word, and is never read as shell syntax.
  test('a float running a command hands it its arguments as they were given', () => {
    const { exitCode, stdout } = float(['printf', '[%s]', 'a b', "it's", '$HOME', '#1;id'], {
      MOCK_TMUX_LIST_PANES: '4242',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("[a b][it's][$HOME][#1;id]");
  });

  // Closing the float (its ×, `kill-pane`) hangs its shell up before the
  // command returns; the caller waits on the channel and must still wake.
  test('a float closed under its command still wakes the caller waiting on it', () => {
    const { exitCode, tmuxCalls } = float(['sh', '-c', 'kill -HUP $PPID; sleep 0.2'], {
      MOCK_TMUX_LIST_PANES: '4242',
    });
    expect(exitCode).toBe(0);
    const waits = tmuxCalls.filter((c) => c.args[0] === 'wait-for').map((c) => c.args.join(' '));
    expect(waits).toEqual([
      expect.stringMatching(/^wait-for -S float-done-/),
      expect.stringMatching(/^wait-for float-done-/),
    ]);
  });

  test('inside a float, a bare float reuses it rather than opening another', () => {
    const { exitCode, verb } = float(['true'], { MOCK_TMUX_WINDOW_TYPE: 'float' });
    expect(exitCode).toBe(0);
    expect(verb).toBe('');
  });

  // Under --json the answer is one object: the verb's for a float nothing
  // waits on, and with the command's output for one that is waited on.
  test('under --json a float answers its ids, and a waited-for command its output too', () => {
    const made = float(['--json']);
    expect(made.exitCode).toBe(0);
    expect(made.verb).toBe('float --pane %5 --json');
    expect(JSON.parse(made.stdout)).toEqual({ ok: true, paneId: '%99', windowId: '@98' });

    const waited = float(['--json', 'printf', 'hi'], { MOCK_TMUX_LIST_PANES: '4242' });
    expect(waited.exitCode).toBe(0);
    expect(JSON.parse(waited.stdout)).toEqual({
      ok: true,
      paneId: '%99',
      windowId: '@98',
      stdout: 'hi',
    });
  });
});
