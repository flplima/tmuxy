/**
 * The CLI's contract with scripts and agents (`tmuxy --help`, "Exit codes"):
 * every exit code, label targets, `pane run --wait` / `pane wait` handing a
 * program's status through, `--json` on every command, and the caller's pane
 * named on every command that used to go target-less.
 */

const fs = require('fs');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');

// A caller that really runs in pane %1.
const IN_PANE_1 = {
  TMUX_SOCKET: 'tmuxy',
  TMUX_PANE: '%1',
  MOCK_TMUX_PANE_PID: String(process.pid),
};

const runShells = (calls) => calls.filter((c) => c.args[0] === 'run-shell').map((c) => c.args[1]);

describe('exit codes', () => {
  test('0 ok, and the help documents every code', () => {
    const { stdout, exitCode } = runCLI(['--help']);
    expect(exitCode).toBe(0);
    for (const line of [
      '0    ok',
      '2    bad command line',
      '3    target not found',
      '4    no tmux server',
      '130  interrupted',
    ]) {
      expect(stdout).toContain(line);
    }
  });

  test('2: a bad command line, before anything reaches tmux', () => {
    for (const args of [
      ['frobnicate'],
      ['pane', 'frob'],
      ['pane', 'resize'],
      ['pane', 'run'],
      ['tab', 'select'],
    ]) {
      const { exitCode, tmuxCalls } = runCLI(args);
      expect({ args, exitCode }).toEqual({ args, exitCode: 2 });
      expect(runShells(tmuxCalls)).toEqual([]);
    }
  });

  test('4: no tmux server on the socket, for a query and for a mutation', () => {
    const env = { MOCK_TMUX_NO_SERVER: '1' };
    const list = runCLI(['pane', 'list'], { env });
    expect(list.exitCode).toBe(4);
    expect(list.stderr).toContain("no tmux server on socket 'tmuxy'");

    const split = runCLI(['pane', 'split'], { env });
    expect(split.exitCode).toBe(4);
    expect(split.stderr).toContain('no tmux server');

    const json = runCLI(['pane', 'split', '--json'], { env });
    expect(json.exitCode).toBe(4);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: "no tmux server on socket 'tmuxy'",
      code: 4,
    });
  });

  test('1: tmux refused the command', () => {
    const { exitCode } = runCLI(['pane', 'kill', '%7'], { env: { MOCK_TMUX_EXIT_CODE: '1' } });
    expect(exitCode).toBe(1);
  });
});

describe('label targets', () => {
  const LABELS = ['%1\t\tzsh\tmain:0', '%4\tlogs\tnpm\tmain:1', '%5\ttests\tjest\tmain:1'].join(
    '\\n',
  );

  test('a label naming one pane is that pane', () => {
    const { exitCode, tmuxCalls, stdout } = runCLI(['pane', 'kill', 'logs', '--json'], {
      env: { MOCK_TMUX_LABELS: LABELS },
    });
    expect(exitCode).toBe(0);
    expect(runShells(tmuxCalls)).toEqual(["tmux -L tmuxy killp -t '%4'"]);
    expect(JSON.parse(stdout)).toEqual({ ok: true, paneId: '%4' });
  });

  test('a pane title is a label too, after the @tmuxy-label option', () => {
    const { exitCode, tmuxCalls } = runCLI(['pane', 'select', 'jest'], {
      env: { MOCK_TMUX_LABELS: LABELS },
    });
    expect(exitCode).toBe(0);
    expect(runShells(tmuxCalls)).toEqual(["tmux -L tmuxy selectp -t '%5'"]);
  });

  test('3: no such label, and nothing changed', () => {
    const { exitCode, stderr, tmuxCalls } = runCLI(['pane', 'kill', 'build'], {
      env: { MOCK_TMUX_LABELS: LABELS },
    });
    expect(exitCode).toBe(3);
    expect(stderr).toContain("no pane labeled or titled 'build'");
    expect(runShells(tmuxCalls)).toEqual([]);
  });

  test('3: two panes labeled the same — both listed, nothing changed', () => {
    const env = {
      MOCK_TMUX_LABELS: ['%4\tlogs\tnpm\tmain:1', '%6\tlogs\ttail\tother:0'].join('\\n'),
    };
    const text = runCLI(['pane', 'kill', 'logs'], { env });
    expect(text.exitCode).toBe(3);
    expect(text.stderr).toContain("'logs' names 2 panes; nothing changed");
    expect(text.stderr).toContain('%4');
    expect(text.stderr).toContain('%6');
    expect(runShells(text.tmuxCalls)).toEqual([]);

    const json = runCLI(['pane', 'kill', 'logs', '--json'], { env });
    expect(json.exitCode).toBe(3);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: "'logs' names 2 panes; nothing changed",
      code: 3,
      matches: [
        { paneId: '%4', tab: 'main:1' },
        { paneId: '%6', tab: 'other:0' },
      ],
    });
    expect(runShells(json.tmuxCalls)).toEqual([]);
  });

  test('a tmux id is never looked up as a label', () => {
    const { tmuxCalls } = runCLI(['pane', 'kill', '%9']);
    expect(tmuxCalls.map((c) => c.args[0])).toEqual(['run-shell']);
  });

  test('pane send -t takes a label, and says so when none matches', () => {
    const sent = runCLI(['pane', 'send', '-t', 'tests', 'ls', 'Enter'], {
      env: {
        ...IN_PANE_1,
        MOCK_TMUX_LABELS: LABELS,
        MOCK_TMUX_ANSWER: 'yes',
        MOCK_TMUX_PANE_ID: '%5',
      },
    });
    expect(sent.exitCode).toBe(0);
    expect(runShells(sent.tmuxCalls).some((l) => l.includes("send-keys -t '%5'"))).toBe(true);

    const none = runCLI(['pane', 'send', '-t', 'nope', 'ls'], {
      env: { ...IN_PANE_1, MOCK_TMUX_LABELS: LABELS },
    });
    expect(none.exitCode).toBe(3);
  });

  test('a tab is named by its name as well, uniquely', () => {
    const names = { MOCK_TMUX_TAB_NAMES: ['@0\tmain\ttmuxy', '@3\teditor\ttmuxy'].join('\\n') };
    const one = runCLI(['tab', 'select', 'editor'], { env: names });
    expect(one.exitCode).toBe(0);
    expect(runShells(one.tmuxCalls)).toEqual(["tmux -L tmuxy select-window -t '@3'"]);

    const none = runCLI(['tab', 'kill', 'logs'], { env: names });
    expect(none.exitCode).toBe(3);
    expect(runShells(none.tmuxCalls)).toEqual([]);
  });
});

describe('the caller’s pane is the target', () => {
  // tmux resolves a target-less command from an unattached client to the
  // session's CURRENT window — so from a pane whose tab is not the active
  // one, `pane split` used to split the active tab.
  test.each([
    [['pane', 'split', '-h'], "splitw -h -t %1 -P -F '##{pane_id}'"],
    [['pane', 'kill'], 'killp -t %1'],
    [['pane', 'select', '-R'], 'selectp -R -t %1'],
    [['pane', 'zoom'], 'resizep -Z -t %1'],
    [['pane', 'resize', '-U', '5'], 'resizep -t %1 -U 5'],
    [['pane', 'break'], "breakp -s %1 -t '#{session_id}:' -P -F '##{window_id}'"],
    [
      ['tab', 'create', 'x'],
      "splitw -t %1 \\; breakp -t '#{session_id}:' -n 'x' -P -F '##{window_id}'",
    ],
    [['tab', 'kill'], 'killw -t %1'],
    [['tab', 'next'], 'next-window -t %1'],
    [['tab', 'rename', 'y'], "rename-window -t %1 'y'"],
    [['tab', 'layout', 'tiled'], "select-layout -t %1 'tiled'"],
  ])('%j names pane %%1', (args, expected) => {
    const { exitCode, tmuxCalls } = runCLI(args, { env: IN_PANE_1 });
    expect(exitCode).toBe(0);
    expect(runShells(tmuxCalls)).toEqual([`TMUX_PANE=%1 tmux -L tmuxy ${expected}`]);
  });

  test('capture reads the caller’s pane, and list its tab, not the active one', () => {
    const capture = runCLI(['pane', 'capture'], { env: IN_PANE_1 });
    expect(capture.tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%1']);
    const list = runCLI(['pane', 'list'], { env: IN_PANE_1 });
    expect(list.tmuxCalls[0].args).toEqual(['list-panes', '-t', '%1']);
  });
});

describe('pane run', () => {
  const runStatus = (status, args = []) =>
    runCLI(['pane', 'run', '--wait', ...args, '--', 'false'], {
      env: { ...IN_PANE_1, MOCK_TMUX_RUN_STATUS: String(status) },
    });

  test('`-- false` exits 1 and `-- true` exits 0, so a script can branch', () => {
    expect(runStatus(1).exitCode).toBe(1);
    expect(runStatus(0).exitCode).toBe(0);
    expect(runStatus(7).exitCode).toBe(7);
  });

  test('splits below the caller, with the options as tmux flags, and prints the pane', () => {
    const { exitCode, stdout, tmuxCalls } = runCLI(
      [
        'pane',
        'run',
        '--split',
        'right',
        '--ratio',
        '30',
        '--cwd',
        '/tmp/x y',
        '--focus=false',
        '--label',
        'logs',
        '--',
        'npm',
        'test',
      ],
      { env: IN_PANE_1 },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('%99');
    const [split, label] = runShells(tmuxCalls);
    expect(split).toMatch(
      /^TMUX_PANE=%1 tmux -L tmuxy splitw -t %1 -h -d -l 30% -c '\/tmp\/x y' -P -F '##\{pane_id\}' 'bash \/tmp\/tmuxy-run\.[^/]+\/run\.sh'$/,
    );
    expect(label).toBe("TMUX_PANE=%1 tmux -L tmuxy set-option -p -t %99 @tmuxy-label 'logs'");
  });

  test('the command reaches the wrapper word for word: a quoted word stays one word', () => {
    const { exitCode, tmuxCalls } = runCLI(
      ['pane', 'run', '--', 'sh', '-c', 'echo hello from logs; sleep 300'],
      { env: IN_PANE_1 },
    );
    expect(exitCode).toBe(0);
    const [split] = runShells(tmuxCalls);
    const wrapper = /'bash (\/tmp\/tmuxy-run\.[^/]+\/run\.sh)'/.exec(split)[1];
    const script = fs.readFileSync(wrapper, 'utf8');
    fs.rmSync(path.dirname(wrapper), { recursive: true, force: true });
    expect(script).toContain('sh -c echo\\ hello\\ from\\ logs\\;\\ sleep\\ 300');
  });

  test('--json: the pane, and with --wait the status', () => {
    const made = runCLI(['pane', 'run', '--json', '--', 'true'], { env: IN_PANE_1 });
    expect(JSON.parse(made.stdout)).toEqual({ ok: true, paneId: '%99' });

    const waited = runStatus(3, ['--json']);
    expect(waited.exitCode).toBe(3);
    expect(JSON.parse(waited.stdout)).toEqual({ ok: false, paneId: '%99', status: 3 });
  });

  test('--for gives up with exit 1 when the program is still running', () => {
    const { exitCode, stderr } = runCLI(
      ['pane', 'run', '--wait', '--for', '1s', '--', 'sleep', '9'],
      {
        env: IN_PANE_1,
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('still running');
  });

  test('a bad duration or split is a usage error', () => {
    expect(runCLI(['pane', 'run', '--for', 'soon', '--', 'true']).exitCode).toBe(2);
    expect(runCLI(['pane', 'run', '--split', 'left', '--', 'true']).exitCode).toBe(2);
  });
});

describe('pane wait', () => {
  test('keeps the pane open, then exits with the program’s status', () => {
    const { exitCode, tmuxCalls, stdout } = runCLI(['pane', 'wait', '%4', '--json'], {
      env: { MOCK_TMUX_PANE_DEAD: '1', MOCK_TMUX_PANE_DEAD_STATUS: '2' },
    });
    expect(exitCode).toBe(2);
    expect(runShells(tmuxCalls)).toEqual(["tmux -L tmuxy set-option -p -t '%4' remain-on-exit on"]);
    expect(JSON.parse(stdout)).toEqual({ ok: false, paneId: '%4', status: 2 });
  });

  test('--for: exit 1 once the time is up', () => {
    const { exitCode, stderr } = runCLI(['pane', 'wait', '%4', '--for', '1s']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('still running in %4 after 1s');
  });

  test('3: no such pane', () => {
    const { exitCode } = runCLI(['pane', 'wait', '%4'], { env: { MOCK_TMUX_EXIT_CODE: '1' } });
    expect(exitCode).toBe(3);
  });
});

describe('pane capture', () => {
  test('--trim drops trailing spaces and blank lines', () => {
    const { stdout } = runCLI(['pane', 'capture', '--trim'], {
      env: { MOCK_TMUX_CAPTURE: 'one  \ntwo\n\n   \n' },
    });
    expect(stdout).toBe('one\ntwo\n');
  });

  test('-t names the pane, by id or by label, like every other verb', () => {
    const byId = runCLI(['pane', 'capture', '-t', '%2']);
    expect(byId.tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-t', '%2']);
    const byLabel = runCLI(['pane', 'capture', '-t', 'logs'], {
      env: { MOCK_TMUX_LABELS: '%1\t\tzsh\tmain:0\n%4\tlogs\tnpm\tmain:1' },
    });
    expect(byLabel.tmuxCalls.at(-1).args).toEqual(['capture-pane', '-p', '-t', '%4']);
    expect(runCLI(['pane', 'capture', '-t']).exitCode).toBe(2);
  });

  test('--unwrap and --format vt are capture-pane’s -J and -e', () => {
    const { tmuxCalls } = runCLI(['pane', 'capture', '--unwrap', '--format', 'vt', '%2']);
    expect(tmuxCalls[0].args).toEqual(['capture-pane', '-p', '-J', '-e', '-t', '%2']);
  });

  test('--format html turns colours into spans and escapes the text', () => {
    const { stdout, exitCode } = runCLI(['pane', 'capture', '--format', 'html'], {
      env: { MOCK_TMUX_CAPTURE: '\x1b[1;31mFAIL\x1b[0m <a> \x1b[38;5;208mx\x1b[39m' },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('<pre class="tmuxy-capture">');
    expect(stdout).toContain('<span class="bold fg-1">FAIL</span> &lt;a&gt; ');
    expect(stdout).toContain('<span class="fg-208">x</span>');
    expect(stdout).toContain('</pre>');
  });

  test('--json carries the format', () => {
    const { stdout } = runCLI(['pane', 'capture', '--format', 'vt', '--json'], {
      env: { MOCK_TMUX_CAPTURE: 'a' },
    });
    expect(JSON.parse(stdout)).toEqual({ content: 'a', format: 'vt', paneId: '' });
  });
});

describe('--json on every command', () => {
  test.each([
    [['pane', 'kill', '%2'], { ok: true, paneId: '%2' }],
    [['pane', 'select', '-U'], { ok: true, direction: '-U' }],
    [['pane', 'swap', '%0', '%1'], { ok: true, src: '%0', dst: '%1' }],
    [['pane', 'zoom'], { ok: true }],
    [['pane', 'break'], { ok: true, tabId: '@99' }],
    [['tab', 'create'], { ok: true, tabId: '@99' }],
    [['tab', 'kill', '@2'], { ok: true, tabId: '@2' }],
    [['tab', 'rename', 'x'], { ok: true, name: 'x' }],
    [['tab', 'layout', 'tiled'], { ok: true, layout: 'tiled' }],
    [['nav', 'left'], { ok: true, direction: 'left' }],
    [['run', 'display-message', 'hi'], { ok: true, status: 0, stdout: '' }],
    [['--version'], { ok: true, version: expect.stringMatching(/^\d+\.\d+\.\d+/) }],
  ])('%j --json', (args, expected) => {
    const { stdout, exitCode } = runCLI([...args, '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(expected);
  });

  test('pane state and send answer with the pane', () => {
    const state = runCLI(['pane', 'state', 'working', '--json'], { env: IN_PANE_1 });
    expect(JSON.parse(state.stdout)).toEqual({ ok: true, paneId: '%1', state: 'working' });
    const send = runCLI(['pane', 'send', 'ls', '--json'], { env: IN_PANE_1 });
    expect(JSON.parse(send.stdout)).toEqual({ ok: true, paneId: '%1', sent: true });
  });

  test('a failure is one object on stdout, with the exit code', () => {
    const { stdout, stderr, exitCode } = runCLI(['pane', 'frob', '--json']);
    expect(exitCode).toBe(2);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: false, error: 'Unknown pane command: frob', code: 2 });
  });

  test('run --json reports a failed tmux command without failing the parse', () => {
    const { stdout, exitCode } = runCLI(['run', 'kill-session', '-t', 'nope', '--json'], {
      env: { MOCK_TMUX_EXIT_CODE: '1' },
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ ok: false, status: 1, stdout: '' });
  });

  test('session snapshots --json lists the snapshots as objects', () => {
    const { stdout, exitCode } = runCLI(['session', 'snapshots', '--json'], {
      env: { MOCK_SERVER_SNAPSHOTS: 'work\t2026-10-28 10:00\trunning' },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { name: 'work', saved: '2026-10-28 10:00', state: 'running' },
    ]);
  });
});
