const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { liveSocketDirectory, liveSocketProblem } = require('../helpers/live-socket-guard');
const { tmuxSocket } = require('../helpers/tmux-socket');
const { MOCKS_DIR, SOCKET, scriptEnv, sealedEnv } = require('./helpers/env');
const { runCLI } = require('./helpers/run-cli');
const { startChild, startChildPromised } = require('./helpers/start-child');
const { MOCK_TMUX, sealChildProcesses, sealProblem, suite } = require('./helpers/seal');
const { realTmux, serverAnswers, suiteSocketProblem } = require('./setup/global-setup');
const globalTeardown = require('./setup/global-teardown');

const { killStrays, socketsIn, sweep } = globalTeardown;

/**
 * The suite runs the CLI's real scripts, which kill panes, windows and
 * servers, and it is normally started from a pane of a live tmuxy. Run that
 * way it once closed the tabs it was started from: the CLI ran the real tmux
 * (an inherited `TMUX_BIN`) on a socket the tests named after a released
 * build's. These are the guards that now stand in the way, each made to fail.
 */
describe('the CLI suite cannot reach a tmux server anyone works in', () => {
  const own = suite();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-seal-test-'));
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  test('the run has a socket and a tmux socket directory nobody else has', () => {
    expect(SOCKET).toBe(own.socket);
    expect(own.socket).toMatch(/^tmuxy-cli-\d+-[0-9a-f]{4}$/);
    expect(fs.realpathSync(own.tmpdir)).not.toBe(fs.realpathSync('/tmp'));
    expect(path.basename(own.tmpdir)).toMatch(/^tmuxy-cli-/);
    // Short enough for a real socket on a Mac, whose limit is 104 with the
    // directory resolved (`/private/tmp/...`) and `tmux-<uid>/` in between.
    const longest = path.join('/private', own.tmpdir, 'tmux-4294967295', `${own.socket}-g`);
    expect(longest.length).toBeLessThan(104);
    // And every CLI under test is told to use them, whatever the shell says.
    const env = scriptEnv('/tmp/home');
    expect(env.TMUX_SOCKET).toBe(own.socket);
    expect(env.TMUX_TMPDIR).toBe(own.tmpdir);
    const { tmuxCalls, exitCode } = runCLI(['pane', 'kill']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls[0].args).toEqual(['run-shell', `tmux -L ${own.socket} killp`]);
  });

  test('the setup refuses a socket that is someone else’s, and one a server already answers on', () => {
    const tmpdir = own.tmpdir;
    const ask = (socket, more = {}) =>
      suiteSocketProblem({ socket, tmpdir, shellTmux: '', answers: () => false, ...more });
    expect(ask(own.socket)).toBeNull();
    for (const live of ['tmuxy', 'tmuxy-dev', 'tmuxy-test', 'default']) {
      expect(ask(live)).toContain('a socket people work in');
    }
    expect(ask('')).toContain('no socket is named');
    // The tmux the suite was started from, by name and by path.
    const shellTmux = '/tmp/tmux-1000/mine,4242,0';
    expect(ask('mine', { shellTmux })).toContain('the tmux this shell runs in');
    expect(ask('/tmp/tmux-1000/mine', { shellTmux })).toContain('the tmux this shell runs in');
    expect(ask('theirs', { shellTmux })).toBeNull();
    // A server the run did not start.
    expect(ask(own.socket, { answers: () => true })).toContain('did not start already answers');
    // The directory live servers keep their sockets in is not a private one.
    const live = process.env.TMUX_TMPDIR || '/tmp';
    expect(
      suiteSocketProblem({ socket: own.socket, tmpdir: live, answers: () => false }),
    ).toContain('the directory live tmux servers keep their sockets in');
  });

  test('a socket left in the run’s directory fails the run, and a real server there is seen and killed', async () => {
    expect(serverAnswers(`${own.socket}-nobody`, own.tmpdir)).toBe(false);

    // The teardown, on a directory of its own with a socket in it: the mock
    // makes none, so a socket means a real tmux was started.
    const left = path.join(scratch, 'left-behind');
    fs.mkdirSync(path.join(left, 'tmux-0'), { recursive: true });
    const listener = net.createServer().listen(path.join(left, 'tmux-0', own.socket));
    await new Promise((resolve) => listener.once('listening', resolve));
    try {
      expect(() => sweep(left, null)).toThrow('started a real tmux server');
    } finally {
      listener.close();
    }
    expect(fs.existsSync(left)).toBe(false);
    // A directory with no socket in it is swept without a word.
    const clean = path.join(scratch, 'clean');
    fs.mkdirSync(clean);
    expect(sweep(clean, null)).toBeUndefined();
    expect(fs.existsSync(clean)).toBe(false);

    // Against a real server, where the machine has a tmux: started here on
    // a socket of its own in the run's directory, and killed again.
    const tmux = realTmux();
    if (!tmux) return;
    const socket = `${own.socket}-g`;
    const started = startChild(
      'spawnSync',
      tmux,
      ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'stray', 'sleep 600'],
      { env: sealedEnv({ TMUX_SOCKET: socket }), encoding: 'utf8' },
    );
    expect(started.stderr).toBe('');
    try {
      expect(serverAnswers(socket, own.tmpdir, tmux)).toBe(true);
      expect(suiteSocketProblem({ socket, tmpdir: own.tmpdir, shellTmux: '' })).toContain(
        'did not start already answers',
      );
      expect(socketsIn(own.tmpdir).map((file) => path.basename(file))).toEqual([socket]);
    } finally {
      killStrays(socketsIn(own.tmpdir), own.tmpdir, tmux);
    }
    expect(serverAnswers(socket, own.tmpdir, tmux)).toBe(false);
    // tmux leaves the socket's file where it was: gone with this test, or
    // the run's own teardown would take it for a server some test started.
    for (const file of socketsIn(own.tmpdir)) fs.rmSync(file);
    expect(socketsIn(own.tmpdir)).toEqual([]);
  });

  test.each([
    ['no environment of its own', undefined, 'would inherit the shell’s'],
    [
      'the shell’s own environment',
      () => ({ ...process.env }),
      'TMUX_TMPDIR is not the suite’s own',
    ],
    ['another tmux socket directory', () => sealedEnv({ TMUX_TMPDIR: '/tmp' }), 'TMUX_TMPDIR'],
    ['a TMUX_BIN', () => sealedEnv({ TMUX_BIN: '/usr/bin/tmux' }), 'TMUX_BIN names a tmux'],
    [
      'a released build’s socket',
      () => sealedEnv({ TMUX_SOCKET: 'tmuxy' }),
      'a socket people work in',
    ],
    ['plain tmux’s socket', () => sealedEnv({ TMUX_SOCKET: 'default' }), 'a socket people work in'],
    [
      'the E2E suite’s socket',
      () => sealedEnv({ TMUX_SOCKET: 'tmuxy-test' }),
      'a socket people work in',
    ],
    ['no socket', () => sealedEnv({ TMUX_SOCKET: '' }), 'no socket is named'],
    [
      'a socket path outside the run’s directory',
      () => sealedEnv({ TMUX_SOCKET: '/tmp/x/sock' }),
      'outside the suite’s own directory',
    ],
  ])('a child with %s is not started', (_what, envOf, why) => {
    const env = envOf?.();
    expect(sealProblem(env)).toContain(why);
    // Through the guard on child_process itself, which is what a test meets.
    const marker = path.join(scratch, `ran-${Math.random().toString(16).slice(2)}`);
    const start = () => startChild('spawnSync', 'touch', [marker], env ? { env } : {});
    expect(start).toThrow(/was not started/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('a child whose first tmux is not the mock is not started, and one that plays a pane of a live socket neither', () => {
    // A directory with a tmux of its own, ahead of the mocks.
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(sealProblem(sealedEnv({ PATH: `${bin}:${MOCKS_DIR}` }))).toContain('not the mock');
    // The mock by another name is still the mock, and no tmux at all is none to reach.
    const linked = path.join(scratch, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(MOCK_TMUX, path.join(linked, 'tmux'));
    expect(sealProblem(sealedEnv({ PATH: `${linked}:/usr/bin:/bin` }))).toBeNull();
    expect(sealProblem(sealedEnv({ PATH: path.join(scratch, 'empty') }))).toBeNull();
    // No PATH is not "no tmux": a shell then searches a default one.
    expect(sealProblem(sealedEnv({ PATH: '' }))).toContain('it has no PATH');
    expect(sealProblem(sealedEnv({ PATH: undefined }))).toContain('it has no PATH');

    // `$TMUX` is a test's to set, to play a pane: never one that is there.
    const listening = path.join(scratch, 'live.sock');
    const server = net.createServer().listen(listening);
    try {
      expect(sealProblem(sealedEnv({ TMUX: `${listening},1,0` }))).toContain(
        'TMUX names a socket that exists',
      );
    } finally {
      server.close();
    }
    expect(sealProblem(sealedEnv({ TMUX: '/tmp/tmuxy,123,0', TMUX_PANE: '%4' }))).toBeNull();
  });

  test('a sealed child starts, every way a child is started, and the guard comes off again', async () => {
    const env = sealedEnv();
    expect(sealProblem(env)).toBeNull();
    expect(startChild('spawnSync', 'true', [], { env }).status).toBe(0);
    expect(startChild('execFileSync', 'echo', ['ok'], { env, encoding: 'utf8' })).toBe('ok\n');
    expect(startChild('execSync', 'echo ok', { env, encoding: 'utf8' })).toBe('ok\n');
    for (const start of ['spawn', 'execFile', 'exec', 'fork', 'execSync', 'execFileSync']) {
      expect(() => startChild(start, 'true')).toThrow(/was not started/);
    }

    // On a module of its own: guarded, then exactly as it was.
    const calls = [];
    const fake = Object.fromEntries(
      ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'].map((name) => [
        name,
        (...args) => calls.push([name, args[0]]),
      ]),
    );
    const before = { ...fake };
    const unseal = sealChildProcesses(fake);
    expect(() => fake.spawn('tmux', ['kill-server'])).toThrow(/`tmux` was not started/);
    fake.spawn('tmux', ['list-panes'], { env });
    expect(calls).toEqual([['spawn', 'tmux']]);
    unseal();
    expect(fake).toEqual(before);

    // The promise form of exec and execFile goes through the seal as well.
    await expect(startChildPromised('exec', 'echo ok', { env })).resolves.toMatchObject({
      stdout: 'ok\n',
    });
    await expect(startChildPromised('execFile', 'echo', ['ok'], { env })).resolves.toMatchObject({
      stdout: 'ok\n',
    });
    expect(() => startChildPromised('exec', 'echo ok')).toThrow(/was not started/);
  });

  // The E2E suite runs a real tmux on a socket of its own name. It may be
  // told another, never one people work in.
  test('the E2E suite’s socket helper refuses a live socket too', () => {
    const saved = { ...process.env };
    try {
      delete process.env.TMUX_SOCKET;
      process.env.TMUX = '/tmp/tmux-1000/tmuxy,4242,0';
      expect(tmuxSocket()).toBe('tmuxy-test');
      const liveDir = liveSocketDirectory();
      for (const live of [
        'tmuxy',
        'tmuxy-dev',
        'default',
        '/tmp/tmux-1000/tmuxy',
        path.join(liveDir, 'tmuxy'),
        path.join(liveDir, 'default'),
      ]) {
        process.env.TMUX_SOCKET = live;
        expect(tmuxSocket).toThrow(/will not run on/);
      }
      // A live name by its path, from a shell outside any tmux.
      delete process.env.TMUX;
      for (const live of [path.join(liveDir, 'tmuxy'), path.join(liveDir, 'tmuxy-dev')]) {
        process.env.TMUX_SOCKET = live;
        expect(tmuxSocket).toThrow(/a socket people work in/);
      }
      // The same name in a directory of the suite's own is the suite's.
      process.env.TMUX_SOCKET = path.join(scratch, 'tmux-0', 'default');
      expect(tmuxSocket()).toBe(path.join(scratch, 'tmux-0', 'default'));
      process.env.TMUX_SOCKET = 'tmuxy-mine-e2e';
      expect(tmuxSocket()).toBe('tmuxy-mine-e2e');
      expect(liveSocketProblem({ socket: 'tmuxy-mine-e2e', shellTmux: '' })).toBeNull();
    } finally {
      process.env = saved;
    }
  });
});
