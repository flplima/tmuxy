const { tmuxEnv } = require('../helpers/tmux-socket');
const { scriptEnv } = require('./helpers/env');

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
});
