/**
 * Tests for raw mutating command aliases configured in .devcontainer/.tmuxy.defaults.conf.
 *
 * External mutating tmux commands (new-window, split-window, kill-pane, kill-window)
 * while control mode (-CC) is attached crash tmux 3.3a-3.5a.
 * Server-level command-alias entries in tmuxy.defaults.conf intercept these raw calls
 * and print advisory guidance pointing to the safe tmuxy CLI alternative.
 */

const path = require('path');
const { startAliasServer, killAliasServer, runRawTmux } = require('./helpers/tmux-alias');

const DEFAULTS_CONF = path.resolve(__dirname, '../../.devcontainer/.tmuxy.defaults.conf');

function freshSocket() {
  return `tmuxy-alias-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('Server-level mutating command aliases', () => {
  let socket;

  beforeAll(() => {
    socket = freshSocket();
    startAliasServer(socket, DEFAULTS_CONF);
  });

  afterAll(() => {
    killAliasServer(socket);
  });

  test('raw split-window exits with code 1 and warns user to use tmuxy pane split', () => {
    const res = runRawTmux(socket, ['split-window']);
    const output = res.stderr + res.stdout;
    expect(res.status).toBe(1);
    expect(output).toContain('[tmuxy] Error: raw split-window is disabled on the tmuxy socket');
    expect(output).toContain('Use \\"tmuxy pane split\\" instead');

    // Assert session is still alive
    const listRes = runRawTmux(socket, ['list-panes']);
    expect(listRes.status).toBe(0);
  });

  test('raw new-window exits with code 1 and warns user to use tmuxy tab create', () => {
    const res = runRawTmux(socket, ['new-window']);
    const output = res.stderr + res.stdout;
    expect(res.status).toBe(1);
    expect(output).toContain('[tmuxy] Error: raw new-window is disabled on the tmuxy socket');
    expect(output).toContain('Use \\"tmuxy tab create\\" instead');

    const listRes = runRawTmux(socket, ['list-windows']);
    expect(listRes.status).toBe(0);
  });

  test('raw kill-pane exits with code 1 and warns user to use tmuxy pane kill', () => {
    const res = runRawTmux(socket, ['kill-pane']);
    const output = res.stderr + res.stdout;
    expect(res.status).toBe(1);
    expect(output).toContain('[tmuxy] Error: raw kill-pane is disabled on the tmuxy socket');
    expect(output).toContain('Use \\"tmuxy pane kill\\" instead');
  });

  test('raw kill-window exits with code 1 and warns user to use tmuxy tab kill', () => {
    const res = runRawTmux(socket, ['kill-window']);
    const output = res.stderr + res.stdout;
    expect(res.status).toBe(1);
    expect(output).toContain('[tmuxy] Error: raw kill-window is disabled on the tmuxy socket');
    expect(output).toContain('Use \\"tmuxy tab kill\\" instead');
  });

  test('short form splitw bypasses the alias and splits successfully', () => {
    const beforePanes = runRawTmux(socket, ['list-panes', '-F', '#{pane_id}'])
      .stdout.trim()
      .split('\n');

    const splitRes = runRawTmux(socket, ['splitw']);
    expect(splitRes.status).toBe(0);

    const afterPanes = runRawTmux(socket, ['list-panes', '-F', '#{pane_id}'])
      .stdout.trim()
      .split('\n');

    expect(afterPanes.length).toBe(beforePanes.length + 1);
  });
});
