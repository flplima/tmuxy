const { runCLI } = require('./helpers/run-cli');

describe('CLI connect subcommand', () => {
  test('publishes TMUXY_CONNECT_TO/_SESSION via run-shell (explicit session)', () => {
    // Explicit session skips the target-socket `list-sessions` probe (which is
    // legitimately a DIFFERENT socket and would trip the harness's dedicated-
    // socket invariant), leaving just the two env-set publishes.
    const { exitCode, tmuxCalls } = runCLI(['connect', 'default', 'work']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(2);
    // Order matters: the desktop app's watcher polls TMUXY_CONNECT_TO, so the
    // session must be published FIRST. Publishing _TO first lets the 2s poll
    // fire between the two writes and attach the default session instead.
    expect(tmuxCalls[0].args).toEqual([
      'run-shell',
      "tmux -L tmuxy set-environment -g TMUXY_CONNECT_SESSION 'work'",
    ]);
    expect(tmuxCalls[1].args).toEqual([
      'run-shell',
      "tmux -L tmuxy set-environment -g TMUXY_CONNECT_TO 'default'",
    ]);
  });

  test('--help documents both the connect flow and the reconnect', () => {
    const { stdout } = runCLI(['connect', '--help']);
    expect(stdout).toContain('reconnects the tmuxy DESKTOP APP');
    expect(stdout).toContain('runs `tmuxy session connect`');
  });

  test('no arguments runs the connect flow, asking for the server', () => {
    // The destination is what the user types at the prompt.
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-connect-cfg-'));
    try {
      const { exitCode, stdout } = runCLI(['connect'], {
        input: 'felipe@prod\n',
        env: { XDG_CONFIG_HOME: tmpCfg, MOCK_SSH_SESSIONS: 'dev\n' },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('✓ ssh felipe@prod');
      expect(stdout).toContain('✓ attach');
    } finally {
      fs.rmSync(tmpCfg, { recursive: true, force: true });
    }
  });
});

describe('tmuxy session connect <dest> [--socket NAME]', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  test('runs the 4 connect stages, persists last_used to servers.json, and publishes TMUXY_CONNECT_*', () => {
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-connect-cfg-'));
    try {
      const { exitCode, stdout, tmuxCalls } = runCLI(
        ['session', 'connect', 'felipe@prod', '--socket', 'work'],
        {
          env: {
            XDG_CONFIG_HOME: tmpCfg,
            MOCK_SSH_SESSIONS: 'dev\n',
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim().split('\n')).toEqual([
        '✓ ssh felipe@prod',
        '✓ tmux 3.5a on the socket work',
        '✓ listing sessions',
        '✓ attach',
      ]);
      expect(tmuxCalls).toEqual([
        {
          args: ['run-shell', "tmux -L tmuxy set-environment -g TMUXY_CONNECT_SSH 'felipe@prod'"],
        },
        {
          args: ['run-shell', "tmux -L tmuxy set-environment -g TMUXY_CONNECT_SESSION 'dev'"],
        },
        {
          args: ['run-shell', "tmux -L tmuxy set-environment -g TMUXY_CONNECT_TO 'work'"],
        },
      ]);

      const servers = JSON.parse(
        fs.readFileSync(path.join(tmpCfg, 'tmuxy', 'servers.json'), 'utf8'),
      );
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        id: 'ssh-felipe-prod-work',
        label: 'felipe@prod',
        kind: 'ssh',
        socket: 'work',
        ssh: { host: 'prod', user: 'felipe' },
      });
      expect(typeof servers[0].last_used).toBe('number');
    } finally {
      fs.rmSync(tmpCfg, { recursive: true, force: true });
    }
  });

  test('prints ✗ stage and verbatim ssh stderr when ssh fails', () => {
    const { exitCode, stderr, tmuxCalls } = runCLI(['session', 'connect', 'badhost'], {
      env: {
        MOCK_SSH_FAIL: '1',
        MOCK_SSH_STDERR: 'Permission denied (publickey).',
      },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('✗ ssh badhost');
    expect(stderr).toContain('Permission denied (publickey).');
    expect(tmuxCalls).toHaveLength(0);
  });
});
