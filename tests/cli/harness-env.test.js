const os = require('os');
const { tmuxEnv } = require('../helpers/tmux-socket');
const { scriptEnv } = require('./helpers/env');
const { runCLI } = require('./helpers/run-cli');
const { driverEnv } = require('../tauri/helpers/tauri-driver');

/**
 * The suites run from a developer's shell, which is often inside tmuxy and
 * signed in to it. A server under test that inherits `TMUXY_PASSWORD` answers
 * the harness's readiness probe 401 until setup times out; a script that
 * inherits `TMUX` acts on the developer's own session.
 */
describe('the environment a test hands its children', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test.each([
    ['tmuxEnv (E2E servers, tmux, the CLI)', () => tmuxEnv()],
    ['scriptEnv (CLI scripts)', () => scriptEnv('/tmp/home')],
    ['driverEnv (tauri-driver, and the app it launches)', () => driverEnv()],
  ])('%s carries nothing of the developer session', (_name, envOf) => {
    Object.assign(process.env, {
      TMUXY_PASSWORD: 'hunter2',
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%3',
      TMUXY_SERVER_BIN: '/opt/tmuxy/tmuxy',
      APPIMAGE: '/opt/tmuxy.AppImage',
      XDG_STATE_HOME: '/home/dev/.local/state',
    });
    const env = envOf();
    for (const name of [
      'TMUXY_PASSWORD',
      'TMUX',
      'TMUX_PANE',
      'TMUXY_SERVER_BIN',
      'APPIMAGE',
      'XDG_STATE_HOME',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  // tmuxy exports `TMUX_BIN` into every pane, and the CLI runs that binary
  // in place of the `tmux` on PATH. A CLI test that inherited it ran the
  // real tmux, on the socket the test named (`tmuxy`, a released build's
  // own), where the mock was meant to answer: four `pane send` tests failed
  // on what a live server said, and a test that kills a pane would have
  // asked the developer's own server to. A test that names a tmux of its own
  // still gets it.
  test('a CLI script runs the mock tmux, whatever tmux the shell exports', () => {
    process.env.TMUX_BIN = '/opt/tmuxy/bin/tmux';
    expect(scriptEnv('/tmp/home')).not.toHaveProperty('TMUX_BIN');
    expect(scriptEnv('/tmp/home', { TMUX_BIN: '/usr/bin/false' }).TMUX_BIN).toBe('/usr/bin/false');

    // And through a whole run: the mock recorded the call, so it was the
    // mock that ran. A binary that is not there would have failed the CLI.
    process.env.TMUX_BIN = '/nonexistent/tmuxy-test/tmux';
    const { exitCode, tmuxCalls } = runCLI(['pane', 'list']);
    expect(exitCode).toBe(0);
    expect(tmuxCalls.map((call) => call.args[0])).toEqual(['list-panes']);
  });

  // The server under test snapshots its sessions into its state dir and
  // restores from it at start: the developer's would hand a run their tabs.
  test("an E2E server's state dir is the suite's, whatever the shell exports", () => {
    process.env.TMUXY_STATE_DIR = '/home/dev/.local/state/tmuxy';
    expect(tmuxEnv().TMUXY_STATE_DIR.startsWith(os.tmpdir())).toBe(true);
  });

  // The desktop app mirrors this branch's config and scripts into the dirs it
  // is handed at start: a local Tauri run must not hand it the installed app's.
  test("the Tauri app's home and tmuxy dirs are the suite's", () => {
    Object.assign(process.env, {
      HOME: '/home/dev',
      XDG_CONFIG_HOME: '/home/dev/.config',
      TMUXY_DATA_DIR: '/home/dev/.local/share/tmuxy',
      TMUXY_STATE_DIR: '/home/dev/.local/state/tmuxy',
      DISPLAY: ':99',
    });
    const env = driverEnv();
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'TMUXY_DATA_DIR', 'TMUXY_STATE_DIR']) {
      expect(env[name].startsWith(os.tmpdir())).toBe(true);
    }
    expect(env.DISPLAY).toBe(':99');
  });
});
