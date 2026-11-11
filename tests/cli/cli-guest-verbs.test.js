const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { guestMachine } = require('./helpers/guest-verbs');

/**
 * The in-browser guests (the v86 snapshot behind the demo and the v86
 * stories, the CheerpX image) have no tmuxy-server: the CLI's Rust verbs run
 * there from `tmuxy-verbs`, built without the `native` feature. Here the real
 * binary, built that way, is the only one on PATH, against the mock tmux:
 * every command written in Rust reaches it, and one that needs the server
 * answers as not available, under the CLI's contract, rather than as a
 * missing binary.
 */
describe('CLI on a machine with only the guest verbs binary', () => {
  let machine;

  beforeAll(() => {
    machine = guestMachine();
  }, 600_000);

  afterAll(() => machine?.remove());

  function guest(args, env = {}) {
    return runCLI(args, {
      cli: machine.cli,
      path: machine.path,
      env: { HOME: machine.home, TMUX_BIN: '', TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%5', ...env },
    });
  }

  test('pane float makes the float and answers its pane', () => {
    const { stdout, stderr, exitCode, tmuxCalls } = guest(['pane', 'float'], {
      MOCK_TMUX_WINDOW_ID: '@3',
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('%99');
    const made = tmuxCalls.find((c) => c.args[0] === 'run-shell');
    expect(made.args[1]).toContain('split-window -t %5');
    expect(made.args[1]).toContain('@tmuxy-window-type float');
  });

  test('tab create makes the tab beside the caller and answers its id', () => {
    const { stdout, exitCode, tmuxCalls } = guest(['tab', 'create', 'logs', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, tabId: '@99' });
    expect(tmuxCalls.find((c) => c.args[0] === 'run-shell').args[1]).toContain('breakp -n logs');
  });

  test('run hands a reading command to tmux inside run-shell', () => {
    const { exitCode, tmuxCalls } = guest(['run', 'list-panes']);
    expect(exitCode).toBe(0);
    const ran = tmuxCalls.find((c) => c.args[0] === 'run-shell');
    expect(ran.target).toBe('%5');
    expect(ran.args[1]).toMatch(/tmux -L tmuxy list-panes/);
  });

  // Into the caller's own pane, which asks nobody: the pane's process is an
  // ancestor of the CLI (jest itself).
  test('pane send types the keys into the caller’s pane', () => {
    const { exitCode, tmuxCalls } = guest(['pane', 'send', 'echo', 'hi'], {
      MOCK_TMUX_PANE_PID: String(process.pid),
    });
    expect(exitCode).toBe(0);
    const sent = tmuxCalls.filter((c) => c.args[0] === 'run-shell').map((c) => c.args[1]);
    expect(sent).toEqual([expect.stringMatching(/send-keys -t %5 .*echo/)]);
  });

  test('config paths answers the files', () => {
    const { stdout, exitCode } = guest(['config', 'paths', '--json']);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).dirs.config).toBe(path.join(machine.home, '.config', 'tmuxy'));
  });

  /**
   * The doctor against the real verb: a `tmuxy.conf` in a scratch config
   * dir sources a file that is not there. The first run names the line and
   * exits 1; `--fix` comments it out behind a backup; the next run is clean.
   */
  test('config doctor reports a dead source-file by line, and --fix comments it out', () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-doctor-'));
    const configDir = path.join(configHome, 'tmuxy');
    fs.mkdirSync(configDir);
    const conf = path.join(configDir, 'tmuxy.conf');
    fs.writeFileSync(
      conf,
      'set -g prefix C-a\nsource-file ~/.config/tmuxy/tmuxy.defaults.conf\nset -g mouse on\n',
    );
    const env = { XDG_CONFIG_HOME: configHome };
    try {
      const dead = guest(['config', 'doctor'], env);
      expect(dead.exitCode).toBe(1);
      expect(dead.stderr).toContain(`${conf}:2: source-file ~/.config/tmuxy/tmuxy.defaults.conf`);
      expect(dead.stderr).toContain('run: tmuxy config doctor --fix');
      expect(dead.tmuxCalls).toEqual([]);

      const asJson = guest(['config', 'doctor', '--json'], env);
      expect(asJson.exitCode).toBe(1);
      expect(JSON.parse(asJson.stdout)).toMatchObject({
        ok: false,
        code: 1,
        dead: [{ file: conf, line: 2, written: '~/.config/tmuxy/tmuxy.defaults.conf' }],
      });

      const fixed = guest(['config', 'doctor', '--fix'], env);
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stdout).toContain('Commented out 1 line(s)');
      const lines = fs.readFileSync(conf, 'utf8').split('\n');
      expect(lines[0]).toBe('set -g prefix C-a');
      expect(lines[1]).toMatch(
        /^# tmuxy config doctor: .* does not exist: source-file ~\/.config\/tmuxy\/tmuxy.defaults.conf$/,
      );
      expect(lines[2]).toBe('set -g mouse on');
      const backups = fs.readdirSync(configDir).filter((f) => f.startsWith('tmuxy.conf.bak-'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(configDir, backups[0]), 'utf8')).toContain(
        '\nsource-file ~/.config/tmuxy/tmuxy.defaults.conf\n',
      );

      const clean = guest(['config', 'doctor'], env);
      expect(clean.exitCode).toBe(0);
      expect(clean.stdout).toContain('every source-file target exists');
    } finally {
      fs.rmSync(configHome, { recursive: true, force: true });
    }
  });

  /**
   * `permissions.json` against the real verbs, in a scratch config dir: the
   * checker says what the file holds and what a send would get, and a real
   * `pane send` into another pane is refused by a deny rule with no question
   * put up, and asked where the tmux option alone would have skipped it.
   */
  describe('permissions.json', () => {
    let configHome;
    let file;
    let env;

    beforeEach(() => {
      configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-permissions-'));
      fs.mkdirSync(path.join(configHome, 'tmuxy'));
      file = path.join(configHome, 'tmuxy', 'permissions.json');
      env = { XDG_CONFIG_HOME: configHome };
    });

    afterEach(() => fs.rmSync(configHome, { recursive: true, force: true }));

    const RULES = {
      callers: {
        claude: { allow: ['Send(gh *)'], ask: ['Send(gh pr merge *)'], deny: ['Send(rm *)'] },
        '*': { deny: ['Send(sudo *)'] },
      },
    };
    const check = (keys, ...flags) =>
      guest(
        ['config', 'permissions', '--caller', 'claude', '--into', 'zsh', ...flags, '--', ...keys],
        env,
      );

    test('the checker reads the file as a send would, and sends nothing', () => {
      const none = guest(['config', 'permissions'], env);
      expect(none.exitCode).toBe(0);
      expect(none.stdout).toContain(`No ${file}`);

      fs.writeFileSync(file, JSON.stringify(RULES));
      const some = guest(['config', 'permissions'], env);
      expect(some.exitCode).toBe(0);
      expect(some.stdout).toContain('4 rule(s) for 2 caller(s)');

      const denied = check(['rm -rf build', 'Enter']);
      expect(denied.exitCode).toBe(1);
      expect(denied.stderr).toContain('deny: denied by `Send(rm *)` (callers.claude)');
      const star = check(['sudo ls', 'Enter']);
      expect(star.stderr).toContain('denied by `Send(sudo *)` (callers.*)');

      const asked = check(['gh pr merge 3', 'Enter']);
      expect(asked.exitCode).toBe(0);
      expect(asked.stdout).toContain('ask: asked by `Send(gh pr merge *)` (callers.claude)');
      expect(check(['cargo build', 'Enter']).stdout).toContain('ask: no rule matches');
      expect(check(['gh pr list; rm -rf x', 'Enter']).stdout).toContain('ask: the line holds `;`');
      expect(check(['gh pr list']).stdout).toContain('ask: not one command ending in Enter');

      // An allow rule is reported, and said to skip no question.
      const allowed = check(['gh pr list', 'Enter']);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toContain('allow: allowed by `Send(gh *)` (callers.claude)');
      expect(allowed.stdout).toContain('skips no question in this version');

      // --json ahead of the verb, so a key that looks like a flag stays a key.
      const json = guest(
        [
          '--json',
          'config',
          'permissions',
          '--caller',
          'claude',
          '--into',
          'zsh',
          '--',
          'rm x',
          'Enter',
        ],
        env,
      );
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        ok: false,
        code: 1,
        decision: 'deny',
        file,
      });

      for (const run of [none, some, denied, asked, allowed, json]) {
        expect(run.tmuxCalls).toEqual([]);
      }
    });

    test('a file that is not rules is an error, with what is wrong in it', () => {
      fs.writeFileSync(file, JSON.stringify({ callers: { claude: { deny: ['destroy(any)'] } } }));
      const broken = guest(['config', 'permissions'], env);
      expect(broken.exitCode).toBe(1);
      expect(broken.stderr).toContain('cannot be read as rules');
      expect(broken.stderr).toContain('only Send(...) rules are understood by this version');
      // And what a send would get from it is a refusal.
      const send = check(['ls', 'Enter']);
      expect(send.exitCode).toBe(1);
      expect(send.stderr).toContain('deny: permissions.json cannot be read as rules');
    });

    /**
     * A real send, by a caller in no pane, into `%7`, where zsh runs and
     * `@tmuxy-send-ask off` would have typed anything without a question.
     */
    const target = {
      MOCK_TMUX_PANE_ID: '%7',
      MOCK_TMUX_PANE_COMMAND: 'off\t\t\tzsh\tidle',
      TMUX_PANE: '',
    };
    const ran = (calls) => calls.filter((c) => c.args[0] === 'run-shell').map((c) => c.args[1]);

    test('a send a deny rule matches is refused: nothing typed, no question', () => {
      fs.writeFileSync(file, JSON.stringify(RULES));
      const { stderr, exitCode, tmuxCalls } = guest(
        ['pane', 'send', '-t', '%7', 'sudo rm -rf /tmp/x', 'Enter'],
        { ...env, ...target },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('denied by `Send(sudo *)` (callers.*); nothing sent');
      expect(ran(tmuxCalls)).toEqual([]);
    });

    test('with rules for the caller, a send the option would have skipped the question for is asked', () => {
      fs.writeFileSync(file, JSON.stringify(RULES));
      const { stderr, exitCode, tmuxCalls } = guest(
        ['pane', 'send', '-t', '%7', '--timeout', '1', 'ls; sudo ls', 'Enter'],
        { ...env, ...target },
      );
      // Nobody answers the mock's question: the send gives up, having asked.
      expect(exitCode).toBe(1);
      expect(stderr).toContain('no answer from %7');
      const commands = ran(tmuxCalls).join('\n');
      expect(commands).toContain('@tmuxy-ask ');
      expect(commands).not.toContain('send-keys');
    });

    test('without the file the option still skips the question', () => {
      const { exitCode, tmuxCalls } = guest(['pane', 'send', '-t', '%7', 'sudo ls', 'Enter'], {
        ...env,
        ...target,
      });
      expect(exitCode).toBe(0);
      const commands = ran(tmuxCalls).join('\n');
      expect(commands).toContain('send-keys -t %7');
      expect(commands).not.toContain('@tmuxy-ask ');
    });

    test('a file that is not rules refuses a send it could not have bound', () => {
      fs.writeFileSync(file, '{ "callers": ');
      const { stderr, exitCode, tmuxCalls } = guest(['pane', 'send', '-t', '%7', 'ls', 'Enter'], {
        ...env,
        ...target,
        MOCK_TMUX_PANE_COMMAND: 'off\t\t\tvim\tidle',
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('permissions.json cannot be read as rules (not JSON');
      expect(ran(tmuxCalls)).toEqual([]);
    });
  });

  test('skill prints the agent guide', () => {
    const { stdout, exitCode } = guest(['skill']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('name: tmuxy');
  });

  test('pane capture --format html renders the colours as spans', () => {
    const { stdout, stderr, exitCode } = guest(['pane', 'capture', '--format', 'html'], {
      MOCK_TMUX_CAPTURE: '\x1b[1;31mFAIL\x1b[0m <a> \x1b[38;5;208mx\x1b[39m',
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toBe(
      '<pre class="tmuxy-capture">\n' +
        '<span class="bold fg-1">FAIL</span> &lt;a&gt; <span class="fg-208">x</span>\n' +
        '</pre>\n',
    );
  });

  // `pane group` runs the pane-group script inside run-shell, which the mock
  // does not play; the script is run here as run-shell would run it.
  test('the pane-group script runs the group verb', () => {
    const { stderr, exitCode } = machine.runScript('pane-group', ['move', '%4', 'x'], {
      TMUX_SOCKET: 'tmuxy',
    });
    expect(stderr).toContain('pane-group move:');
    expect(stderr).not.toContain('not found');
    expect(exitCode).toBe(1);
  });

  test.each([
    [['session', 'snapshots'], 'session'],
    [['session', 'connect'], 'session-connect'],
    [['plugin', 'list'], 'plugin'],
    [['trace'], 'trace'],
  ])('%j needs the server: a contract failure naming it', (args, verb) => {
    const json = guest([...args, '--json']);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: `\`${verb}\` is not available here: it needs tmuxy-server, which this machine does not have`,
      code: 1,
    });
    const text = guest(args);
    expect(text.exitCode).toBe(1);
    expect(text.stdout).toBe('');
    expect(text.stderr).toContain(`Error: \`${verb}\` is not available here`);
  });
});
