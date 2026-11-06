const { runCLI } = require('./helpers/run-cli');

describe('CLI connect subcommand', () => {
  /**
   * The request itself — one variable, checked where the desktop app reads it
   * — is the server binary's `connect` verb (tmuxy_core::servers::connect,
   * tested there); the mock server prints the command line it was given.
   */
  test('hands the socket and session to the connect verb (explicit session)', () => {
    // An explicit session skips the target-socket `list-sessions` probe (a
    // DIFFERENT socket, which would trip the harness's dedicated-socket check).
    const { exitCode, stdout, tmuxCalls } = runCLI(['connect', 'default', 'work']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls).toHaveLength(0);
    expect(stdout).toContain('mock-server-started connect --socket default --session work\n');
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
        env: { TMUXY_STATE_DIR: tmpCfg, MOCK_SSH_SESSIONS: 'dev\n' },
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

  test('runs the 4 connect stages, and saves and publishes through the connect verb', () => {
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-connect-cfg-'));
    try {
      const { exitCode, stdout, tmuxCalls } = runCLI(
        ['session', 'connect', 'felipe@prod', '--socket', 'work'],
        {
          env: {
            TMUXY_STATE_DIR: tmpCfg,
            MOCK_SSH_SESSIONS: 'dev\n',
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(stdout.trim().split('\n')).toEqual([
        '✓ ssh felipe@prod',
        '✓ tmux 3.5a on the socket work',
        '✓ listing sessions',
        'mock-server-started connect --save --socket work --session dev --ssh felipe@prod',
        '✓ attach',
      ]);
      expect(tmuxCalls).toEqual([]);
    } finally {
      fs.rmSync(tmpCfg, { recursive: true, force: true });
    }
  });

  // ssh runs a ProxyCommand as a local command, so an option that reaches it
  // as the destination is code execution — pasted `ssh ` prefix or not.
  test.each(['ssh -oProxyCommand=touch%20/tmp/owned', ' -oProxyCommand=id', 'host;id', 'a b'])(
    'refuses %p as a destination before running ssh',
    (dest) => {
      const { exitCode, stderr, stdout, tmuxCalls } = runCLI(['session', 'connect', dest]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('is not a [user@]host destination');
      expect(stdout).not.toContain('✓ ssh');
      expect(tmuxCalls).toHaveLength(0);
    },
  );

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

  // The session the server lists first is attached when none is named. A name
  // tmuxy will not put on a command line is passed over for the next one,
  // never turned into no session at all.
  test('attaches the first listed session with a safe name, skipping the stash', () => {
    const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-connect-cfg-'));
    try {
      const { exitCode, stdout } = runCLI(['session', 'connect', 'felipe@prod'], {
        env: {
          TMUXY_STATE_DIR: tmpCfg,
          MOCK_SSH_SESSIONS: '__tmuxy_stash\n-x\nmy work\ndev\nother\n',
        },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('connect --save --socket tmuxy --session dev --ssh felipe@prod');
    } finally {
      fs.rmSync(tmpCfg, { recursive: true, force: true });
    }
  });

  test.each(['../escape', 'rel/socket', '/tmp/../bad', 'sock;id', '-L'])(
    'refuses unsafe --socket %p in both local and remote connect flows',
    (badSocket) => {
      const local = runCLI(['session', 'connect', 'localhost', '--socket', badSocket]);
      expect(local.exitCode).not.toBe(0);
      expect(local.tmuxCalls).toHaveLength(0);

      const remote = runCLI(['session', 'connect', 'felipe@prod', '--socket', badSocket]);
      expect(remote.exitCode).not.toBe(0);
      expect(remote.tmuxCalls).toHaveLength(0);

      const direct = runCLI(['connect', badSocket]);
      expect(direct.exitCode).not.toBe(0);
      expect(direct.tmuxCalls).toHaveLength(0);
    },
  );
});
